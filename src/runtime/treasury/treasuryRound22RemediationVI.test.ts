/**
 * 【Round 22 Remediation VI】固定反例测试——exact completion supersession、
 * durable historical authority、outcome 绑定、统一删除入口与满载活性。
 *
 * 覆盖任务书第五节 T1–T13（T14 架构扫描在 treasuryWriteArchitecture.test.ts
 * 的 "Treasury completion supersession 架构守卫（Remediation VI）" describe）：
 * - T1/T2：相反 outcome 的 GRA/tombstone 不得删除 completion；
 * - T3/T4：同 outcome 下任一 exact identity 维度冲突（durable/contract/
 *   cohort/profile/lowlevel；tr1_ generation/parent/binding）不得 supersede；
 * - T5：final committed tombstone 单独存在不证明 cleanup 完成；
 * - T6：settlement relabeling 被权威 outcome 阻断；
 * - T7：supersession 写入中断窗口 A–E（fault 注入）；
 * - T8：ephemeral replacement（GRA/tombstone）被正式生命周期回收后历史
 *   权威仍有效；
 * - T9：真实 300-generation chain（generation 1..300 实际执行）；
 * - T10/T11/T12：真实 admission 路径的满载可回收/不可回收/store unhealthy；
 * - T13：identity conflict 写入失败零全局 GC 副作用。
 */
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import {
  quarantineTreasuryTransaction,
  readTreasuryQuarantineEntry,
  releaseTreasuryQuarantineEntry,
} from "@/runtime/treasury/quarantine";
import {
  writeTreasuryResolutionTombstone,
  readTreasuryResolutionTombstone,
  resetTreasuryResolutionStoreForTest,
  peekTreasuryResolutionStoreHealth,
} from "@/runtime/treasury/resolutionStore";
import {
  openTreasuryResolutionCleanup,
  treasuryResolutionCleanupOpenInputOfFacts,
  markTreasuryResolutionCleanupStage,
  resetTreasuryResolutionCleanupHeapCacheForTest,
} from "@/runtime/treasury/resolutionCleanupJournal";
import { registerTreasuryCleanupProofProbesForAssembly } from "@/runtime/treasury/settlementProofActivation";
import { registerTreasuryOppositeProofDepsForAssembly } from "@/runtime/treasury/oppositeProofMatrix";
import {
  recordTreasuryCleanupCompletion,
  lookupTreasuryCleanupCompletion,
  peekTreasuryCleanupCompletionHealth,
  peekTreasuryCleanupCompletionEntryCount,
  clearTreasuryCleanupCompletionDurableForTest,
  resetTreasuryCleanupCompletionHeapCacheForTest,
  TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES,
} from "@/runtime/treasury/cleanupCompletionAuthority";
import {
  archiveTreasuryCleanupCompletionViaAuthority,
  clearTreasuryCleanupSupersessionDurableForTest,
  ensureTreasuryCleanupCompletionHeadroom,
  injectTreasurySupersessionArchiveFaultForTest,
  lookupTreasuryHistoricalCompletion,
  peekTreasuryCleanupSupersessionEntryCount,
  peekTreasuryCleanupSupersessionHealth,
  resetTreasuryCleanupSupersessionHeapCacheForTest,
  verifyTreasuryExactCompletionReplacement,
  verifyTreasuryHistoricalCompletionStatus,
  TREASURY_CLEANUP_SUPERSESSION_MAX_ENTRIES,
} from "@/runtime/treasury/cleanupSupersessionAuthority";
import { resolveTreasuryDurableSettlementAuthority } from "@/runtime/treasury/historicalSettlementAuthority";
import { lookupTreasuryChainRetirementCertificate, peekTreasuryChainCertificateEntryCount } from "@/runtime/treasury/chainRetirementCertificate";
import {
  registerTreasuryCompletionReplacementProbesForAssembly,
  verifyTreasuryCleanupCompletionSupersession,
} from "@/runtime/treasury/cleanupCompletionReplacement";
import {
  advanceTreasuryResolutionCleanupPhases,
  treasuryCleanupStatusOfAdvance,
} from "@/runtime/treasury/resolutionCleanupCoordinator";
import {
  createTreasuryAttemptLineageRecord,
  readTreasuryAttemptLineageRecord,
  stageTreasuryLineageCapabilityIssued,
  stageTreasuryLineageChildIntentPending,
  activateTreasuryLineageChild,
  retireTreasuryLineageCurrentAttempt,
  deriveTreasuryLineageNextChildTransactionId,
  convergeTreasuryLineageRetirementFromFacts,
} from "@/runtime/treasury/attemptLineage";
import { recomputeTreasuryDurableIdentityDigest } from "@/runtime/treasury/identityProof";
import {
  lookupTreasuryGenerationRetirementProofByAttemptId,
  peekTreasuryGenerationRetirementHealth,
} from "@/runtime/treasury/generationRetirementAuthority";
import { compactTreasuryTerminalLineage, lookupTreasuryRetirementSummaryByRoot } from "@/runtime/treasury/lineageRetirementSummary";
// 显式加载 lineageGenerationRetirement（模块加载时注册 tombstone retention 的
// O(1) replacement verdict——正式驱逐通道的装配前置）。
import "@/runtime/treasury/lineageGenerationRetirement";
import { TREASURY_LOWLEVEL_SOURCE_RUNTIME } from "@/runtime/treasury/authorityLevel";
import { treasuryExactAttemptIdentityOfFacts } from "@/runtime/treasury/exactAttemptIdentity";
import { createTreasuryService } from "@/runtime/treasury/facade";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import { installRooms, type RoomSpec } from "@mock/treasury";
import type { TreasuryTransactionInput } from "@/runtime/treasury/types";

const DIGEST = "0123456789abcdef";
const RUNTIME = TREASURY_LOWLEVEL_SOURCE_RUNTIME;
/** resolution tombstone retention（与 resolutionStore 常量同值——测试内驱动正式驱逐用）。 */
const TREASURY_RESOLUTION_RETENTION_TICKS_FOR_TEST = 5_000;

jest.setTimeout(180_000);

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

function seedFinalCommittedTombstone(transactionId: string, durable: string): void {
  // final committed tombstone 的正式写入有状态机前置（resolving → final）——
  // 测试 fixture 直接持久层注入完整形状（与 faultResolution 测试的注入同模式）。
  if (!Memory.runtime) Memory.runtime = {} as never;
  const runtime = Memory.runtime as unknown as { treasury?: Record<string, unknown> };
  runtime.treasury = runtime.treasury ?? {};
  const branch = runtime.treasury as {
    resolutions?: { version: number; entries: Record<string, unknown>; entryCount: number; updatedAt: number };
  };
  const entries = branch.resolutions?.entries ?? {};
  entries["r:" + transactionId] = {
    transactionId,
    digest: DIGEST,
    resolution: "committed",
    stage: "final",
    proofLevel: "lowlevel",
    lowlevelSource: RUNTIME,
    durableIdentityDigest: durable,
    actionTick: Game.time,
    settledAtTick: Game.time,
    observationTick: Game.time,
    resolvedAtTick: Game.time,
    reconcilerKind: "terminal.send",
  };
  branch.resolutions = {
    version: 7,
    entries,
    entryCount: Object.keys(entries).length,
    updatedAt: Game.time,
  };
  resetTreasuryResolutionStoreForTest();
}

/** 建立 root（gen0）GRA：retiring lineage + final tombstone + authority 释放 + converge。 */
function seedRootGra(transactionId: string, durable: string, rearmable: boolean): string {
  const created = createTreasuryAttemptLineageRecord({
    rootTransactionId: transactionId,
    rootIdentity: { digest: DIGEST, durableIdentityDigest: durable, lowlevelSource: RUNTIME },
    actionKind: "terminal.send",
    authorityClass: "lowlevel",
    lowlevelSource: RUNTIME,
    rearmable,
    identityProfile: "lowlevel",
    ...(rearmable ? { retrySemanticDigest: "7777777777777777" } : { nonRearmReason: "test fixture" }),
  });
  if (created.status !== "written") throw new Error("seed rejected: " + ("detail" in created ? created.detail : ""));
  const lineageId = created.record.lineageId;
  seedFinalNotExecutedTombstone(transactionId, durable);
  expect(releaseTreasuryQuarantineEntry(transactionId)).toBe(true);
  expect(convergeTreasuryLineageRetirementFromFacts(lineageId).status).toBe("completed");
  expect(lookupTreasuryGenerationRetirementProofByAttemptId(transactionId)).toBeDefined();
  return lineageId;
}

function validCompletionProof(
  transactionId: string,
  durable: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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

function seedHistoricalStore(entries: Record<string, unknown>): void {
  if (!Memory.runtime) Memory.runtime = {} as never;
  const runtime = Memory.runtime as unknown as { treasury?: Record<string, unknown> };
  runtime.treasury = runtime.treasury ?? {};
  (runtime.treasury as { cleanupSupersessions?: unknown }).cleanupSupersessions = {
    version: 1,
    entries,
    entryCount: Object.keys(entries).length,
    updatedAt: Game.time,
  };
  resetTreasuryCleanupSupersessionHeapCacheForTest();
}

function validHistoricalRecord(transactionId: string, durable: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    lineageDisposition: "final",
    via: "compact-archive",
    archivedAtTick: Game.time,
    ...overrides,
  };
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryResolutionStoreForTest();
  resetTreasuryResolutionCleanupHeapCacheForTest();
  clearTreasuryCleanupCompletionDurableForTest();
  resetTreasuryCleanupCompletionHeapCacheForTest();
  clearTreasuryCleanupSupersessionDurableForTest();
  resetTreasuryCleanupSupersessionHeapCacheForTest();
  injectTreasurySupersessionArchiveFaultForTest(null);
  registerTreasuryCleanupProofProbesForAssembly({
    readTombstone: (transactionId) => readTreasuryResolutionTombstone(transactionId),
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
    readTombstone: (transactionId) => readTreasuryResolutionTombstone(transactionId) as never,
    listCompletionTransactionIds: () =>
      Object.keys(((Memory.runtime as unknown as { treasury?: { cleanupCompletions?: { entries?: Record<string, unknown> } } })?.treasury?.cleanupCompletions?.entries) ?? {}).map((key) => key.slice(3)),
    completionAbsentAfterRelease: (transactionId) => lookupTreasuryCleanupCompletion(transactionId).verdict === "absent",
  });
});

afterEach(() => {
  injectTreasurySupersessionArchiveFaultForTest(null);
});

afterAll(() => {
  registerTreasuryCleanupProofProbesForAssembly(null);
  registerTreasuryOppositeProofDepsForAssembly(null);
  registerTreasuryCompletionReplacementProbesForAssembly(null);
});

// ── T1/T2：相反 outcome 的 replacement 不得删除 completion ─────────────────

describe("Remediation VI T1/T2：outcome 相反的 replacement 不 supersede", () => {
  it("T1：not_executed GRA 不得删除 committed completion（blocked、completion 保留、零其它 GC）", () => {
    const root = "vi_t1_root";
    const durable = seedQuarantine(root);
    // GRA（resolution 恒 not_executed）正式写入。
    seedRootGra(root, durable, false);
    // committed completion（同 transactionId、identity 全维度与 GRA 一致）。
    seedCompletionStore({
      ["cc:" + root]: validCompletionProof(root, durable, { resolution: "committed" }),
      "cc:vi_t1_other": validCompletionProof("vi_t1_other", "0123456789abc001"),
    });
    const historicalBefore = peekTreasuryCleanupSupersessionEntryCount();
    const archived = archiveTreasuryCleanupCompletionViaAuthority({ transactionId: root, via: "gra-proof" });
    expect(archived.status).toBe("blocked");
    if (archived.status === "blocked") expect(archived.reason).toBe("replacement_conflict");
    // committed completion 保留；GRA 存在但不得据此删除。
    expect(lookupTreasuryCleanupCompletion(root).verdict).toBe("match");
    // 不发生其它 entry GC（另一条 completion 与 historical 均不变）。
    expect(lookupTreasuryCleanupCompletion("vi_t1_other").verdict).toBe("match");
    expect(peekTreasuryCleanupSupersessionEntryCount()).toBe(historicalBefore);
    // exact replacement 查询同样 conflict（outcome 维度）。
    const supersession = verifyTreasuryCleanupCompletionSupersession(root);
    expect(supersession.verdict).not.toBe("superseded");
  });

  it("T2：final committed tombstone 不得替代 not-executed completion", () => {
    const root = "vi_t2_root";
    const durable = seedQuarantine(root);
    // not-executed completion 在位；同 ID 存在 final committed tombstone。
    seedCompletionStore({ ["cc:" + root]: validCompletionProof(root, durable) });
    seedFinalCommittedTombstone(root, durable);
    const archived = archiveTreasuryCleanupCompletionViaAuthority({ transactionId: root, via: "any-exact" });
    expect(archived.status).toBe("blocked");
    if (archived.status === "blocked") expect(archived.reason).toBe("replacement_conflict");
    expect(lookupTreasuryCleanupCompletion(root).verdict).toBe("match");
    expect(lookupTreasuryHistoricalCompletion(root).verdict).toBe("absent");
  });
});

// ── T3/T4：同 outcome 下 exact identity 维度冲突 ───────────────────────────

describe("Remediation VI T3/T4：identity 维度冲突不得 supersede（completion 保留）", () => {
  function freshRootGra(tag: string): { readonly root: string; readonly durable: string } {
    const root = "vi_t3_" + tag;
    const durable = seedQuarantine(root);
    seedRootGra(root, durable, false);
    return { root, durable };
  }

  const dimensionCases: ReadonlyArray<{ readonly label: string; readonly mutate: (identity: Record<string, unknown>) => void }> = [
    { label: "durableIdentityDigest 冲突", mutate: (i) => { i.durableIdentityDigest = "9999999999abc001"; } },
    { label: "proofClass/profile 冲突（identity-bound vs lowlevel）", mutate: (i) => { i.identityProfile = "modern-contract"; i.proofClass = "identity-bound"; delete i.lowlevelSource; i.contractDigest = "8888888888abc002"; i.authorizationCohortDigest = "7777777777abc003"; } },
    { label: "lowlevelSource 冲突", mutate: (i) => { i.lowlevelSource = "migrated-lowlevel@v1"; } },
  ];

  for (const dimension of dimensionCases) {
    it(`T3：${dimension.label} → replacement conflict、completion 保留`, () => {
      const { root, durable } = freshRootGra(dimension.label.slice(0, 4));
      const identity: Record<string, unknown> = {
        digest: DIGEST,
        identityProfile: "lowlevel",
        proofClass: "lowlevel",
        durableIdentityDigest: durable,
        lowlevelSource: RUNTIME,
      };
      dimension.mutate(identity);
      seedCompletionStore({ ["cc:" + root]: validCompletionProof(root, durable, { identity }) });
      const exact = verifyTreasuryExactCompletionReplacement({
        transactionId: root,
        completion: validCompletionProof(root, durable, { identity }) as never,
      });
      expect(exact.verdict).toBe("conflict");
      const archived = archiveTreasuryCleanupCompletionViaAuthority({ transactionId: root, via: "gra-proof" });
      expect(archived.status).toBe("blocked");
      if (archived.status === "blocked") expect(archived.reason).toBe("replacement_conflict");
      expect(lookupTreasuryCleanupCompletion(root).verdict).toBe("match");
      expect(peekTreasuryCleanupSupersessionEntryCount()).toBe(0);
    });
  }

  it("T3b：contractDigest 冲突（completion vs 已存在 historical authority）→ supersession_identity_conflict、completion 保留", () => {
    const root = "vi_t3_ib1";
    const durable = seedQuarantine(root);
    const historicalIdentity = { digest: DIGEST, identityProfile: "modern-contract", proofClass: "identity-bound", contractDigest: "8888888888abc002", authorizationCohortDigest: "7777777777abc003", durableIdentityDigest: durable };
    const completionIdentity = { ...historicalIdentity, contractDigest: "8888888888abc009" };
    seedHistoricalStore({ ["sa:" + root]: validHistoricalRecord(root, durable, { identity: historicalIdentity }) });
    seedCompletionStore({ ["cc:" + root]: validCompletionProof(root, durable, { identity: completionIdentity }) });
    const archived = archiveTreasuryCleanupCompletionViaAuthority({ transactionId: root, via: "compact-archive" });
    expect(archived.status).toBe("blocked");
    if (archived.status === "blocked") expect(archived.reason).toBe("supersession_identity_conflict");
    expect(lookupTreasuryCleanupCompletion(root).verdict).toBe("match");
    expect(lookupTreasuryHistoricalCompletion(root).verdict).toBe("match"); // 旧权威不被覆盖
  });

  it("T3c：authorizationCohortDigest 冲突（completion vs 已存在 historical authority）→ supersession_identity_conflict", () => {
    const root = "vi_t3_ib2";
    const durable = seedQuarantine(root);
    const historicalIdentity = { digest: DIGEST, identityProfile: "modern-contract", proofClass: "identity-bound", contractDigest: "8888888888abc002", authorizationCohortDigest: "7777777777abc003", durableIdentityDigest: durable };
    const completionIdentity = { ...historicalIdentity, authorizationCohortDigest: "7777777777abc009" };
    seedHistoricalStore({ ["sa:" + root]: validHistoricalRecord(root, durable, { identity: historicalIdentity }) });
    seedCompletionStore({ ["cc:" + root]: validCompletionProof(root, durable, { identity: completionIdentity }) });
    const archived = archiveTreasuryCleanupCompletionViaAuthority({ transactionId: root, via: "compact-archive" });
    expect(archived.status).toBe("blocked");
    if (archived.status === "blocked") expect(archived.reason).toBe("supersession_identity_conflict");
    expect(lookupTreasuryCleanupCompletion(root).verdict).toBe("match");
  });

  it("T4：tr1_ child completion 的 generation/parent/binding 冲突均不得 supersede", () => {
    // 建链到 gen1：GRA(tr1_) 在位后，child completion 手工 seed 并逐维度偏移。
    const chainRoot = "vi_t4_root";
    const rootDurable = seedQuarantine(chainRoot);
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: chainRoot,
      rootIdentity: { digest: DIGEST, durableIdentityDigest: rootDurable, lowlevelSource: RUNTIME },
      actionKind: "terminal.send",
      authorityClass: "lowlevel",
      lowlevelSource: RUNTIME,
      rearmable: true,
      identityProfile: "lowlevel",
      retrySemanticDigest: "7777777777777777",
    });
    if (created.status !== "written") throw new Error("seed rejected");
    const chainLineageId = created.record.lineageId;
    seedFinalNotExecutedTombstone(chainRoot, rootDurable);
    expect(releaseTreasuryQuarantineEntry(chainRoot)).toBe(true);
    expect(convergeTreasuryLineageRetirementFromFacts(chainLineageId).status).toBe("completed");
    const childId = deriveTreasuryLineageNextChildTransactionId(chainLineageId, 1, chainRoot);
    expect(stageTreasuryLineageCapabilityIssued(chainLineageId, childId).status).not.toBe("rejected");
    expect(stageTreasuryLineageChildIntentPending(chainLineageId, childId).status).not.toBe("rejected");
    const record = readTreasuryAttemptLineageRecord(chainLineageId)!;
    const binding = record.pendingBindingDigest!;
    const childDurable = recomputeTreasuryDurableIdentityDigest({
      transactionId: childId, digest: DIGEST, actionKind: "terminal.send", source: "test",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
      lineageId: chainLineageId, lineageGeneration: 1, parentTransactionId: chainRoot, lineageBindingDigest: binding,
    })!;
    expect(activateTreasuryLineageChild(chainLineageId, { digest: DIGEST, durableIdentityDigest: childDurable, lowlevelSource: RUNTIME }).status).not.toBe("rejected");
    expect(retireTreasuryLineageCurrentAttempt({ lineageId: chainLineageId }).status).not.toBe("rejected");
    expect(convergeTreasuryLineageRetirementFromFacts(chainLineageId).status).toBe("completed");
    expect(lookupTreasuryGenerationRetirementProofByAttemptId(childId)).toBeDefined();

    const baseIdentity = {
      digest: DIGEST,
      identityProfile: "lowlevel",
      proofClass: "lowlevel",
      durableIdentityDigest: childDurable,
      lowlevelSource: RUNTIME,
      lineageId: chainLineageId,
      lineageGeneration: 1,
      parentTransactionId: chainRoot,
      lineageBindingDigest: binding,
    };
    const tr1Cases: ReadonlyArray<{ readonly label: string; readonly mutate: (identity: Record<string, unknown>) => void }> = [
      { label: "generation 不同", mutate: (i) => { i.lineageGeneration = 2; } },
      { label: "parent 不同", mutate: (i) => { i.parentTransactionId = "vi_t4_fake_parent"; } },
      { label: "binding 不同", mutate: (i) => { i.lineageBindingDigest = "6666666666666666"; } },
    ];
    for (const tr1Case of tr1Cases) {
      const identity: Record<string, unknown> = { ...baseIdentity };
      tr1Case.mutate(identity);
      const proof = validCompletionProof(childId, childDurable, { identity });
      seedCompletionStore({ ["cc:" + childId]: proof });
      const exact = verifyTreasuryExactCompletionReplacement({
        transactionId: childId,
        completion: proof as never,
      });
      expect(exact.verdict).toBe("conflict");
      const archived = archiveTreasuryCleanupCompletionViaAuthority({ transactionId: childId, via: "gra-proof" });
      expect(archived.status).toBe("blocked");
      if (archived.status === "blocked") expect(archived.reason).toBe("replacement_conflict");
      expect(lookupTreasuryCleanupCompletion(childId).verdict).toBe("match");
      expect(peekTreasuryCleanupSupersessionEntryCount()).toBe(0);
    }
  });
});

// ── T5/T6：tombstone 单独不证明 cleanup；settlement relabel 被阻断 ──────────

describe("Remediation VI T5/T6：final tombstone 单独不证明完成；outcome 绑定", () => {
  it("T5：journal absent + completion absent + historical absent + final committed tombstone present → no_cleanup_authority", () => {
    const root = "vi_t5_root";
    const durable = seedQuarantine(root);
    seedFinalCommittedTombstone(root, durable);
    const advance = advanceTreasuryResolutionCleanupPhases({ transactionId: root });
    expect(advance.status).toBe("no_cleanup_authority");
    expect(advance.phases.markerDischarged).toBe(false);
    expect(treasuryCleanupStatusOfAdvance("committed", advance).stage).toBe("no_cleanup_authority");
    expect(treasuryCleanupStatusOfAdvance("committed", advance).stage).not.toBe("fully_complete");
  });

  it("T6：committed completion 用 not-executed 视角查询 → conflict；public status 不输出 not-executed + fully_complete", () => {
    const root = "vi_t6a_root";
    const durable = seedQuarantine(root);
    seedCompletionStore({ ["cc:" + root]: validCompletionProof(root, durable, { resolution: "committed" }) });
    // committed 视角 → match + completed。
    const committedView = advanceTreasuryResolutionCleanupPhases({ transactionId: root, expectedOutcome: "committed" });
    expect(committedView.status).toBe("completed");
    expect(committedView.settlementOutcome).toBe("committed");
    expect(treasuryCleanupStatusOfAdvance("committed", committedView).stage).toBe("fully_complete");
    // not-executed 视角 → conflict（不得 relabel）。
    const notExecutedView = advanceTreasuryResolutionCleanupPhases({ transactionId: root, expectedOutcome: "not-executed" });
    expect(notExecutedView.status).toBe("completion_conflict");
    // 调用方贴 not-executed 标签 → cleanup_conflict（绝不 not-executed + fully_complete）。
    expect(treasuryCleanupStatusOfAdvance("not-executed", committedView).stage).toBe("cleanup_conflict");
    expect(treasuryCleanupStatusOfAdvance("not-executed", committedView).stage).not.toBe("fully_complete");
  });

  it("T6b：not-executed historical authority 用 committed 视角查询 → conflict", () => {
    const root = "vi_t6b_root";
    const durable = seedQuarantine(root);
    seedHistoricalStore({ ["sa:" + root]: validHistoricalRecord(root, durable) });
    // not-executed 视角（与权威一致）→ completed（journal/completion 均 absent）。
    const matchView = advanceTreasuryResolutionCleanupPhases({ transactionId: root, expectedOutcome: "not-executed" });
    expect(matchView.status).toBe("completed");
    expect(matchView.settlementOutcome).toBe("not-executed");
    // committed 视角 → conflict。
    const committedView = advanceTreasuryResolutionCleanupPhases({ transactionId: root, expectedOutcome: "committed" });
    expect(committedView.status).toBe("completion_conflict");
    expect(treasuryCleanupStatusOfAdvance("committed", matchView).stage).toBe("cleanup_conflict");
    // 查询层同样阻断（expected identity 一致但 outcome 视角相反）。
    const identity = treasuryExactAttemptIdentityOfFacts(root, { digest: DIGEST, durableIdentityDigest: durable, lowlevelSource: RUNTIME }, "lowlevel")!;
    expect(lookupTreasuryHistoricalCompletion(root, identity, "not-executed").verdict).toBe("match");
    expect(lookupTreasuryHistoricalCompletion(root, identity, "committed").verdict).toBe("conflict");
  });
});

// ── T7：supersession 写入中断窗口（fault 注入）────────────────────────────

describe("Remediation VI T7：supersession 写入中断窗口", () => {
  function seedArchivableScene(tag: string): { readonly transactionId: string; readonly durable: string } {
    const transactionId = "vi_t7_" + tag;
    const durable = seedQuarantine(transactionId);
    seedCompletionStore({ ["cc:" + transactionId]: validCompletionProof(transactionId, durable) });
    return { transactionId, durable };
  }

  it("A：historical authority 写入前中断 → completion 保留、historical 无条目", () => {
    const { transactionId } = seedArchivableScene("a");
    injectTreasurySupersessionArchiveFaultForTest("before-authority-write");
    const archived = archiveTreasuryCleanupCompletionViaAuthority({ transactionId, via: "compact-archive" });
    expect(archived.status).toBe("blocked");
    if (archived.status === "blocked") expect(archived.reason).toBe("authority_write_failure");
    expect(lookupTreasuryCleanupCompletion(transactionId).verdict).toBe("match");
    expect(peekTreasuryCleanupSupersessionEntryCount()).toBe(0);
  });

  it("B：authority 写入成功、completion 删除前中断 → 两者并存；reset 后幂等继续、不重复写冲突", () => {
    const { transactionId } = seedArchivableScene("b");
    injectTreasurySupersessionArchiveFaultForTest("after-authority-write");
    const interrupted = archiveTreasuryCleanupCompletionViaAuthority({ transactionId, via: "compact-archive" });
    expect(interrupted.status).toBe("interrupted");
    if (interrupted.status === "interrupted") expect(interrupted.phase).toBe("authority_written");
    // 两者并存。
    expect(lookupTreasuryCleanupCompletion(transactionId).verdict).toBe("match");
    expect(lookupTreasuryHistoricalCompletion(transactionId).verdict).toBe("match");
    // global reset（heap 清空）后幂等继续：不重复写冲突、completion 删除。
    resetTreasuryCleanupCompletionHeapCacheForTest();
    resetTreasuryCleanupSupersessionHeapCacheForTest();
    const resumed = archiveTreasuryCleanupCompletionViaAuthority({ transactionId, via: "compact-archive" });
    expect(resumed.status).toBe("archived");
    expect(lookupTreasuryCleanupCompletion(transactionId).verdict).toBe("absent");
    expect(peekTreasuryCleanupSupersessionEntryCount()).toBe(1);
    // 再次重入 → already_archived（无第三份）。
    expect(archiveTreasuryCleanupCompletionViaAuthority({ transactionId, via: "compact-archive" }).status).toBe("already_archived");
    expect(peekTreasuryCleanupSupersessionEntryCount()).toBe(1);
  });

  it("C：completion 删除后、返回前中断 → historical 可独立查询；global reset 后仍 completed", () => {
    const { transactionId } = seedArchivableScene("c");
    expect(archiveTreasuryCleanupCompletionViaAuthority({ transactionId, via: "compact-archive" }).status).toBe("archived");
    // global reset 模拟。
    resetTreasuryCleanupCompletionHeapCacheForTest();
    resetTreasuryCleanupSupersessionHeapCacheForTest();
    expect(lookupTreasuryHistoricalCompletion(transactionId).verdict).toBe("match");
    const advance = advanceTreasuryResolutionCleanupPhases({ transactionId });
    expect(advance.status).toBe("completed");
    expect(advance.settlementOutcome).toBe("not-executed");
  });

  it("D：authority read-back 失败 → completion 保留、authority 回滚（无残留）", () => {
    const { transactionId } = seedArchivableScene("d");
    injectTreasurySupersessionArchiveFaultForTest("corrupt-authority-readback");
    const archived = archiveTreasuryCleanupCompletionViaAuthority({ transactionId, via: "compact-archive" });
    expect(archived.status).toBe("blocked");
    if (archived.status === "blocked") expect(archived.reason).toBe("read_back_failure");
    expect(lookupTreasuryCleanupCompletion(transactionId).verdict).toBe("match");
    // 回滚后 historical 无条目（读取 unhealthy 时 read_back_failure 已回滚；
    // corrupt 注入在 durable 拷贝上篡改，回滚删除条目 → absent）。
    resetTreasuryCleanupSupersessionHeapCacheForTest();
    const after = lookupTreasuryHistoricalCompletion(transactionId);
    expect(after.verdict === "absent" || after.verdict === "store_unhealthy").toBe(true);
    expect(peekTreasuryCleanupSupersessionEntryCount()).toBe(0);
  });

  it("E：completion 删除 read-back 仍存在 → blocked pending；后续幂等恢复", () => {
    const { transactionId } = seedArchivableScene("e");
    injectTreasurySupersessionArchiveFaultForTest("resurrect-after-delete");
    const archived = archiveTreasuryCleanupCompletionViaAuthority({ transactionId, via: "compact-archive" });
    expect(archived.status).toBe("blocked");
    if (archived.status === "blocked") expect(archived.reason).toBe("delete_read_back_failure");
    // historical authority 已在（删除 read-back 失败不回滚 authority）。
    expect(lookupTreasuryHistoricalCompletion(transactionId).verdict).toBe("match");
    // 后续幂等恢复（假条目清除——下 tick 重删成功的等价模拟）。
    const store = (Memory.runtime as unknown as { treasury?: { cleanupCompletions?: { entries?: Record<string, unknown>; entryCount?: number } } }).treasury!.cleanupCompletions!;
    delete store.entries["cc:" + transactionId];
    store.entryCount = Object.keys(store.entries).length;
    resetTreasuryCleanupCompletionHeapCacheForTest();
    expect(archiveTreasuryCleanupCompletionViaAuthority({ transactionId, via: "compact-archive" }).status).toBe("already_archived");
    expect(advanceTreasuryResolutionCleanupPhases({ transactionId }).status).toBe("completed");
  });
});

// ── T8：ephemeral replacement 消失后历史权威仍有效 ─────────────────────────

describe("Remediation VI T8：GRA/tombstone 被正式生命周期回收后历史权威仍有效", () => {
  it("archive → 正式 retention 驱逐 tombstone + 联动释放 GRA → reset 后 historical 查询 exact completed", () => {
    const root = "vi_t8_root";
    const durable = seedQuarantine(root);
    const lineageId = seedRootGra(root, durable, false);
    seedCompletionStore({ ["cc:" + root]: validCompletionProof(root, durable) });
    expect(archiveTreasuryCleanupCompletionViaAuthority({ transactionId: root, via: "gra-proof" }).status).toBe("archived");
    expect(lookupTreasuryGenerationRetirementProofByAttemptId(root)).toBeDefined();
    expect(readTreasuryResolutionTombstone(root)).toBeDefined();
    // 正式 terminal compaction（active record → summary；root GRA 仍保留——
    // tombstone 依赖在位）。compaction 尾部 root completion 幂等归档。
    expect(compactTreasuryTerminalLineage(lineageId).status).toBe("compacted");
    expect(lookupTreasuryRetirementSummaryByRoot(root)).toBeDefined();
    // 正式 retention 生命周期：retention 到期（Game.time 推进 5001+）→ 塞满
    // resolution store（过期 committed filler——同 faultResolution 注入模式）
    // → 满载写入触发惰性驱逐：root 的 not-executed tombstone verdict match
    //（GRA 在位 exact）→ 驱逐 + GRA 联动释放（active record 已被 summary
    // 替代 → 释放条件成立）。
    Game.time += TREASURY_RESOLUTION_RETENTION_TICKS_FOR_TEST + 1;
    const branch = (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury!;
    const resolutions = branch.resolutions as { entries: Record<string, unknown>; entryCount: number; updatedAt: number };
    for (let index = 0; resolutions.entryCount < 256; index += 1) {
      const fillerId = "vi_t8_filler_" + index;
      resolutions.entries["r:" + fillerId] = {
        transactionId: fillerId, digest: DIGEST, resolution: "committed", stage: "final",
        proofLevel: "legacy", actionTick: Game.time, settledAtTick: Game.time,
        observationTick: Game.time, resolvedAtTick: Game.time,
        reconcilerKind: "terminal.send",
      };
      resolutions.entryCount += 1;
    }
    resolutions.updatedAt = Game.time;
    resetTreasuryResolutionStoreForTest();
    const dummy = writeTreasuryResolutionTombstone({
      transactionId: "vi_t8_dummy", digest: DIGEST, resolution: "not-executed", stage: "final",
      proofLevel: "lowlevel", lowlevelSource: RUNTIME, durableIdentityDigest: "0123456789abc009",
      actionTick: Game.time, observationTick: Game.time, resolvedAtTick: Game.time,
      reconcilerKind: "terminal.send", source: "test",
    } as never);
    expect(dummy.status).not.toBe("rejected");
    // GRA 与 tombstone 已被正式生命周期回收（ephemeral replacement 消失）。
    expect(lookupTreasuryGenerationRetirementProofByAttemptId(root)).toBeUndefined();
    expect(readTreasuryResolutionTombstone(root)).toBeUndefined();
    // global reset 模拟。
    resetTreasuryCleanupCompletionHeapCacheForTest();
    resetTreasuryCleanupSupersessionHeapCacheForTest();
    // 【Remediation VII T17 语义升级】terminal compaction 已把 root 的
    // per-attempt historical entry 压缩为 chain retirement certificate——
    // historical lookup 不再 match（已压缩），完成事实与 authoritative
    // settlement 由 durable settlement authority（certificate）持续证明。
    expect(lookupTreasuryChainRetirementCertificate(root)).toBeDefined();
    const resolved = resolveTreasuryDurableSettlementAuthority({ transactionId: root });
    // 【Remediation VIII C4】压缩后 root 权威 = certificate 协议推导（protocol）。
    expect(resolved.status).toBe("protocol");
    if (resolved.status === "protocol") expect(resolved.outcome).toBe("not-executed");
    // 【Remediation VIII B3/S8 语义更新】journal absent 且 completion/
    // historical 均已被压缩（只剩 settlement certificate）——certificate
    // 只证明 settlement outcome，不证明五阶段 cleanup 完成 →
    // no_cleanup_authority（fail closed，不得 completed）。
    expect(advanceTreasuryResolutionCleanupPhases({ transactionId: root }).status).toBe("no_cleanup_authority");
    // 错误 outcome 视角仍 conflict（certificate 绑定 authoritative outcome）。
    expect(resolveTreasuryDurableSettlementAuthority({ transactionId: root, expectedOutcome: "committed" }).status).toBe("conflict");
  });
});

// ── T9：真实 300-generation chain ─────────────────────────────────────────

describe("Remediation VI T9：真实 300-generation chain（root + generation 1..300 实际执行）", () => {
  it("300 代链：正式 helper、每代 completion+archive、周期 retention/GC/reset、终态 compaction；全部历史可查", () => {
    const root = "vi_chain_root";
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
    if (created.status !== "written") throw new Error("seed rejected");
    const lineageId = created.record.lineageId;
    let currentId = root;
    let currentDurable = rootDurable;
    let currentBinding: string | undefined;
    let currentParent: string | undefined;
    let currentGeneration = 0;
    let resets = 0;
    seedFinalNotExecutedTombstone(root, rootDurable);
    expect(releaseTreasuryQuarantineEntry(root)).toBe(true);

    const settleParentCleanup = (parentId: string, parentDurable: string, generation: number): void => {
      // parent 的 final not-executed tombstone（tr1_ 带 lineage 四字段；root
      // 已在链 seed 时写入——retire 后的 not-executed settlement 权威）。
      if (readTreasuryResolutionTombstone(parentId) === undefined && generation > 0) {
        seedFinalNotExecutedTombstone(parentId, parentDurable, {
          lineageId,
          lineageGeneration: generation,
          ...(currentParent !== undefined ? { parentTransactionId: currentParent } : {}),
          ...(currentBinding !== undefined ? { lineageBindingDigest: currentBinding } : {}),
        });
      }
      // 正式 journal open（tr1_ 带 lineage 四字段）+ 手工激活 + marker ack。
      const opened = openTreasuryResolutionCleanup(
        treasuryResolutionCleanupOpenInputOfFacts({
          transactionId: parentId,
          digest: DIGEST,
          resolution: "not-executed",
          proofClass: "lowlevel",
          lowlevelSource: RUNTIME,
          durableIdentityDigest: parentDurable,
          ...(generation > 0
            ? {
                lineageId,
                lineageGeneration: generation,
                ...(currentParent !== undefined ? { parentTransactionId: currentParent } : {}),
                ...(currentBinding !== undefined ? { lineageBindingDigest: currentBinding } : {}),
              }
            : {}),
        }),
      );
      expect(opened.status).toBe("opened");
      const store = (Memory.runtime as unknown as { treasury?: { resolutionCleanup?: { entries?: Record<string, { settlementProofDurable?: boolean }> } } }).treasury?.resolutionCleanup;
      store!.entries!["c:" + parentId]!.settlementProofDurable = true;
      expect(markTreasuryResolutionCleanupStage(parentId, "marker_discharge", "already_absent")).not.toBe("rejected");
      const advanced = advanceTreasuryResolutionCleanupPhases({ transactionId: parentId });
      expect(advanced.status).toBe("completed");
    };

    for (let generation = 1; generation <= 300; generation++) {
      // 1) parent 代的 GRA（converge 正式写入——state retiring → rearm_ready；
      //    advance 的 lineage 阶段消费 already_final 事实）。
      expect(convergeTreasuryLineageRetirementFromFacts(lineageId).status).toBe("completed");
      // 2) parent 的 cleanup completion（正式五阶段）。
      settleParentCleanup(currentId, currentDurable, currentGeneration);
      // 3) child staging。
      const childId = deriveTreasuryLineageNextChildTransactionId(lineageId, generation, root);
      expect(stageTreasuryLineageCapabilityIssued(lineageId, childId).status).not.toBe("rejected");
      expect(stageTreasuryLineageChildIntentPending(lineageId, childId).status).not.toBe("rejected");
      const binding = readTreasuryAttemptLineageRecord(lineageId)!.pendingBindingDigest!;
      const childDurable = recomputeTreasuryDurableIdentityDigest({
        transactionId: childId, digest: DIGEST, actionKind: "terminal.send", source: "test",
        postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
        lineageId, lineageGeneration: generation, parentTransactionId: currentId, lineageBindingDigest: binding,
      })!;
      // 4) activate：统一 archive 入口回收 parent completion（GRA exact）。
      expect(activateTreasuryLineageChild(lineageId, { digest: DIGEST, durableIdentityDigest: childDurable, lowlevelSource: RUNTIME }).status).not.toBe("rejected");
      expect(lookupTreasuryCleanupCompletion(currentId).verdict).toBe("absent");
      expect(verifyTreasuryHistoricalCompletionStatus(currentId).verdict).toBe("match");
      // 5) child 退休（末代 non-rearmable → terminal）。
      const retired = retireTreasuryLineageCurrentAttempt(
        generation === 300 ? { lineageId, rearmable: false, nonRearmReason: "chain terminal fixture" } : { lineageId },
      );
      expect(retired.status).not.toBe("rejected");
      currentParent = currentId;
      currentBinding = binding;
      currentId = childId;
      currentDurable = childDurable;
      currentGeneration = generation;
      // 周期性维护：每 25 代推进 Game.time（retention 到期）+ 写一条 dummy
      // tombstone 触发惰性驱逐（正式 retention/GRA lifecycle 通道）+ global
      // reset 模拟（各 store heap 失效）。
      if (generation % 25 === 0) {
        Game.time += TREASURY_RESOLUTION_RETENTION_TICKS_FOR_TEST + 1;
        const dummy = writeTreasuryResolutionTombstone({
          transactionId: "vi_chain_dummy_" + generation, digest: DIGEST, resolution: "not-executed", stage: "final",
          proofLevel: "lowlevel", lowlevelSource: RUNTIME, durableIdentityDigest: ("000000000000000" + String(generation)).slice(-16),
          actionTick: Game.time, observationTick: Game.time, resolvedAtTick: Game.time,
          reconcilerKind: "terminal.send", source: "test",
        } as never);
        expect(dummy.status).not.toBe("rejected");
        resetTreasuryCleanupCompletionHeapCacheForTest();
        resetTreasuryCleanupSupersessionHeapCacheForTest();
        resets += 1;
      }
    }
    expect(resets).toBeGreaterThanOrEqual(12); // 至少 12 次 global reset 模拟。

    // 末代（generation 300，state=non_rearmable_retired 终态）：completion
    //（tombstone + 正式五阶段）→ 归档（tombstone exact）→ 正式 terminal
    // compaction（active record → summary、孤儿 GRA 清理、root/final
    // completion 幂等归档）。
    settleParentCleanup(currentId, currentDurable, 300);
    expect(archiveTreasuryCleanupCompletionViaAuthority({ transactionId: currentId, via: "any-exact" }).status).toBe("archived");
    // 压缩前（historical 仍承载 per-attempt exact identity）：错误 identity/
    // outcome 不 match——exact 层身份维度在压缩发生前验证。
    const gen150 = deriveTreasuryLineageNextChildTransactionId(lineageId, 150, root);
    const gen300 = deriveTreasuryLineageNextChildTransactionId(lineageId, 300, root);
    expect(lookupTreasuryHistoricalCompletion(gen150, undefined, "committed").verdict).toBe("conflict");
    const wrongIdentity = treasuryExactAttemptIdentityOfFacts(gen300, { digest: DIGEST, durableIdentityDigest: "1111111111abc300", lowlevelSource: RUNTIME, lineageId, lineageGeneration: 300, parentTransactionId: gen150, lineageBindingDigest: "2222222222abc300" }, "lowlevel");
    expect(wrongIdentity).not.toBeNull();
    expect(lookupTreasuryHistoricalCompletion(gen300, wrongIdentity!).verdict).toBe("conflict");
    expect(compactTreasuryTerminalLineage(lineageId).status).toBe("compacted");
    // compaction 后 active record 被 summary 替代。
    expect(lookupTreasuryRetirementSummaryByRoot(root)).toBeDefined();

    // 容量边界：live completion store 未超硬容量。
    expect(peekTreasuryCleanupCompletionEntryCount()).toBeLessThanOrEqual(TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES);
    // 【Remediation VII T17】terminal compaction 后 chain 压缩：不再保留
    // 301 条 per-attempt 永久 historical records——chain 级永久 footprint 与
    // generation 数量无关（certificate 一条）。
    expect(peekTreasuryCleanupSupersessionEntryCount()).toBe(0);
    expect(peekTreasuryChainCertificateEntryCount()).toBe(1);
    const certificate = lookupTreasuryChainRetirementCertificate(root);
    expect(certificate).toBeDefined();
    expect(certificate!.finalGeneration).toBe(300);
    expect(certificate!.terminalState).toBe("non_rearmable_retired");

    // root 与 generation 1..300 全部经 durable settlement authority（chain
    // certificate）可查询、outcome 正确、永久 replay-blocked。
    const expectResolved = (attemptId: string): void => {
      // 【Remediation VIII C4】压缩后代权威 = certificate 协议推导（protocol）。
      const resolved = resolveTreasuryDurableSettlementAuthority({ transactionId: attemptId });
      expect(resolved.status).toBe("protocol");
      if (resolved.status === "protocol") expect(resolved.outcome).toBe("not-executed");
    };
    expectResolved(root);
    for (let generation = 1; generation <= 300; generation++) {
      const attemptId = deriveTreasuryLineageNextChildTransactionId(lineageId, generation, root);
      expectResolved(attemptId);
    }
    // 错误 outcome 视角 / 超出 final generation 的 ID 不 match。
    expect(resolveTreasuryDurableSettlementAuthority({ transactionId: gen300, expectedOutcome: "committed" }).status).toBe("conflict");
    const genBeyond = deriveTreasuryLineageNextChildTransactionId(lineageId, 301, root);
    expect(resolveTreasuryDurableSettlementAuthority({ transactionId: genBeyond }).status).toBe("absent");
    // 【Remediation VIII B3/S8 语义更新】certificate 只证明 settlement
    // outcome（重放阻断经 resolver protocol），不证明 cleanup 五阶段完成
    // ——journal absent + 权威只剩 certificate → no_cleanup_authority
    //（fail closed；cleanup 完成的幂等证明只认 live/historical completion）。
    expect(advanceTreasuryResolutionCleanupPhases({ transactionId: root }).status).toBe("no_cleanup_authority");
    expect(advanceTreasuryResolutionCleanupPhases({ transactionId: gen300 }).status).toBe("no_cleanup_authority");
  });
});

// ── T10/T11/T12：真实 admission 路径的满载活性 ─────────────────────────────

describe("Remediation VI T10–T12：真实 authorize/prepare/execute 的 headroom preflight", () => {
  const ROOMS: RoomSpec[] = [
    {
      name: "W1N57",
      storage: { id: "stor-1", resources: { energy: 100_000 }, freeCapacity: 10_000 },
      terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 5_000 },
    },
  ];

  function makeService(): TreasuryTestService {
    const rooms = installRooms(ROOMS);
    const service = treasuryTestService(createTreasuryService({ getRooms: () => Object.values(rooms) }));
    service.beginTick();
    return treasuryTestService(service);
  }

  function input(service: TreasuryTestService, transactionId: string, delta = -500): TreasuryTransactionInput {
    const epoch = service.observation().epoch;
    return {
      transactionId,
      kind: "terminal.send",
      source: "test",
      decision: { scope: epoch.scope, epochSeq: epoch.epochSeq, observedAtTick: epoch.observedAtTick },
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta }],
    };
  }

  function fullCompletionStore(withReclaimable: boolean): void {
    const entries: Record<string, unknown> = {};
    for (let i = 0; i < TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES; i++) {
      const transactionId = (withReclaimable && i === 0 ? "vi_adm_reclaimable" : "vi_adm_full_" + i);
      entries["cc:" + transactionId] = validCompletionProof(transactionId, String(i).padStart(16, "0"));
    }
    seedCompletionStore(entries);
    expect(peekTreasuryCleanupCompletionEntryCount()).toBe(TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES);
  }

  function fullHistoricalStore(): void {
    const entries: Record<string, unknown> = {};
    for (let i = 0; i < TREASURY_CLEANUP_SUPERSESSION_MAX_ENTRIES; i++) {
      const transactionId = "vi_hist_full_" + i;
      entries["sa:" + transactionId] = validHistoricalRecord(transactionId, String(i).padStart(16, "0"));
    }
    seedHistoricalStore(entries);
    expect(peekTreasuryCleanupSupersessionEntryCount()).toBe(TREASURY_CLEANUP_SUPERSESSION_MAX_ENTRIES);
  }

  it("T10：满载但存在可安全回收项 → prepare preflight 回收一条、authorization/prepare 成功、callback 恰一次、proof 可查", () => {
    const service = makeService();
    fullCompletionStore(true);
    // prepare（低层真实路径）：满载 → state-changing headroom preflight 先
    // bounded exact archive 回收一条 → 容量恢复 → prepared。
    const prepared = service.prepareTransaction(input(service, "vi_t10_tx"));
    expect(prepared.status).toBe("prepared");
    expect(lookupTreasuryHistoricalCompletion("vi_adm_reclaimable").verdict).toBe("match");
    expect(peekTreasuryCleanupCompletionEntryCount()).toBe(TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES - 1);
    // execute：Game callback 前终检通过（刚回收出空间）→ callback 恰好一次。
    let callbacks = 0;
    const result = service.executePreparedAction(input(service, "vi_t10_tx"), () => {
      callbacks += 1;
      return { ok: true };
    });
    expect(callbacks).toBe(1);
    expect(result.status).not.toBe("prepare_rejected");
    // 回收后的 proof 仍可查询（durable historical authority——非空洞）。
    expect(advanceTreasuryResolutionCleanupPhases({ transactionId: "vi_adm_reclaimable" }).status).toBe("completed");
  });

  it("T11：满载且无安全可回收项（historical 亦满）→ prepare/execute 拒绝、callback 零调用、completion 均保留", () => {
    const service = makeService();
    fullCompletionStore(false);
    fullHistoricalStore();
    const prepared = service.prepareTransaction(input(service, "vi_t11_tx"));
    expect(prepared.status).toBe("rejected");
    if (prepared.status === "rejected") expect(prepared.reason).toBe("completion_headroom_exhausted");
    let callbacks = 0;
    const executed = service.executePreparedAction(input(service, "vi_t11_tx"), () => {
      callbacks += 1;
      return { ok: true };
    });
    expect(callbacks).toBe(0);
    expect(executed.status).toBe("prepare_rejected");
    // completion 均保留（零删除——fail closed 不删旧安全事实）。
    expect(peekTreasuryCleanupCompletionEntryCount()).toBe(TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES);
    expect(peekTreasuryCleanupSupersessionEntryCount()).toBe(TREASURY_CLEANUP_SUPERSESSION_MAX_ENTRIES);
  });

  it("T12：completion store unhealthy → 零 archive、零删除、零 callback、明确 store unhealthy（不折叠为无可回收项）", () => {
    const service = makeService();
    seedCompletionStore({ "cc:vi_t12_broken": { schemaVersion: 1 } });
    expect(peekTreasuryCleanupCompletionHealth().healthy).toBe(false);
    expect(ensureTreasuryCleanupCompletionHeadroom({ minSlots: 1 }).status).toBe("store_unhealthy");
    expect(peekTreasuryCleanupSupersessionEntryCount()).toBe(0); // 零 archive
    const prepared = service.prepareTransaction(input(service, "vi_t12_tx"));
    expect(prepared.status).toBe("rejected");
    if (prepared.status === "rejected") expect(prepared.reason).toBe("completion_store_unhealthy");
    let callbacks = 0;
    const executed = service.executePreparedAction(input(service, "vi_t12_tx"), () => {
      callbacks += 1;
      return { ok: true };
    });
    expect(callbacks).toBe(0);
    expect(executed.status).toBe("prepare_rejected");
  });
});

// ── T13：identity conflict 写入失败零全局 GC 副作用 ────────────────────────

describe("Remediation VI T13：identity conflict 写入失败不触发其它 proof GC", () => {
  it("同 ID 不同 identity 的 completion 写入 rejected(existing_conflict) → 其它 completion/historical 完全不变、零回收", () => {
    // 预置两条健康 completion + 一条 historical。
    seedCompletionStore({
      "cc:vi_t13_keep_a": validCompletionProof("vi_t13_keep_a", "0123456789ab0001"),
      "cc:vi_t13_keep_b": validCompletionProof("vi_t13_keep_b", "0123456789ab0002"),
    });
    seedHistoricalStore({ "sa:vi_t13_keep_c": validHistoricalRecord("vi_t13_keep_c", "0123456789ab0003") });
    const completionKeysBefore = JSON.stringify(
      Object.keys((Memory.runtime as unknown as { treasury?: { cleanupCompletions?: { entries?: Record<string, unknown> } } }).treasury!.cleanupCompletions!.entries!).sort(),
    );
    const historicalKeysBefore = JSON.stringify(
      Object.keys((Memory.runtime as unknown as { treasury?: { cleanupSupersessions?: { entries?: Record<string, unknown> } } }).treasury!.cleanupSupersessions!.entries!).sort(),
    );
    // 冲突写入：同 transactionId（vi_t13_keep_a）不同 durableIdentityDigest 的
    // journal entry → record 幂等复验 rejected(existing_conflict)。
    const conflictEntry = {
      transactionId: "vi_t13_keep_a",
      digest: DIGEST,
      resolution: "not-executed" as const,
      identityProfile: "lowlevel",
      proofClass: "lowlevel",
      durableIdentityDigest: "0123456789ab0099",
      lowlevelSource: RUNTIME,
      settlementProofDurable: true,
      markerDischarged: true,
      authorityReleased: true,
      outcomeFinalized: true,
      lineageFinalized: true,
      journalEntryAbsent: false,
    };
    const write = recordTreasuryCleanupCompletion({
      entry: conflictEntry as never,
      lineageDisposition: "final",
      globalWriteAdmissionStillLocked: false,
    });
    expect(write.status).toBe("rejected");
    if (write.status === "rejected") expect(write.reason).toBe("existing_conflict");
    // 零全局 GC 副作用：其它 completion 与 historical 完全不变。
    const completionKeysAfter = JSON.stringify(
      Object.keys((Memory.runtime as unknown as { treasury?: { cleanupCompletions?: { entries?: Record<string, unknown> } } }).treasury!.cleanupCompletions!.entries!).sort(),
    );
    const historicalKeysAfter = JSON.stringify(
      Object.keys((Memory.runtime as unknown as { treasury?: { cleanupSupersessions?: { entries?: Record<string, unknown> } } }).treasury!.cleanupSupersessions!.entries!).sort(),
    );
    expect(completionKeysAfter).toBe(completionKeysBefore);
    expect(historicalKeysAfter).toBe(historicalKeysBefore);
    expect(lookupTreasuryCleanupCompletion("vi_t13_keep_a").verdict).toBe("match");
    expect(peekTreasuryCleanupSupersessionEntryCount()).toBe(1);
  });
});
