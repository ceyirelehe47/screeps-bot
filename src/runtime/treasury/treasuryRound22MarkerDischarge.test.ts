/**
 * 【第二十二轮】marker discharge 与 cleanup journal 核心矩阵测试。
 *
 * 覆盖：marker exact identity relation（v4/v3/unrelated/conflict/insufficient）、
 * discharge 结构化结果与 read-back、journal 持久阶段与 global reset 重建、
 * trusted receipt 分离、purpose 矩阵、profile 推导、GRA/lineage 迁移的
 * 关键路径（完整矩阵由既有 Round 13-21 fixture 升级用例承载）。
 */
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { quarantineTreasuryTransaction, readTreasuryQuarantineEntry } from "@/runtime/treasury/quarantine";
import { writeTreasuryResolutionTombstone } from "@/runtime/treasury/resolutionStore";
import { createTreasuryAttemptLineageRecord } from "@/runtime/treasury/attemptLineage";
import {
  recordTreasuryWriteFault,
  readTreasuryWriteFault,
} from "@/runtime/treasury/writeFault";
import {
  dischargeTreasuryMarkerForAttempt,
  treasuryMarkerDischargeCompletesAttemptPhase,
} from "@/runtime/treasury/markerDischarge";
import {
  treasuryMarkerExactIdentityRelation,
  TREASURY_MARKER_EXACT_PROTOCOL,
} from "@/runtime/treasury/markerExactIdentity";
import {
  openTreasuryResolutionCleanup,
  markTreasuryResolutionCleanupStage,
  readTreasuryResolutionCleanupEntry,
  listTreasuryResolutionCleanupPendingIds,
  completeTreasuryResolutionCleanup,
  resetTreasuryResolutionCleanupForTest,
  registerTreasuryResolutionCleanupHandlersForAssembly,
  recoverTreasuryResolutionCleanupAtTickBoundary,
} from "@/runtime/treasury/resolutionCleanupJournal";
import { acknowledgeTreasuryCleanupSettlementProof } from "@/runtime/treasury/settlementProofActivation";
import { validateTreasuryIdentityProfileFacts, treasuryIdentityProfileOfFacts, treasuryProfileAllowsAutomaticProtocol } from "@/runtime/treasury/identityProfile";
import { validateTreasurySemanticLineage } from "@/runtime/treasury/semanticLineageValidation";
import { lookupTreasuryTrustedSettledReceipt } from "@/runtime/treasury/receipts";

const DIGEST = "0123456789abcdef";

function seedV4Marker(overrides: Record<string, unknown> = {}): void {
  recordTreasuryWriteFault({
    transactionId: "r22_mk_tx",
    digest: DIGEST,
    tick: Game.time,
    kind: "terminal.send",
    source: "test",
    phase: "executing_at_end_tick",
    status: "unresolved",
    recordedAt: Game.time,
    markerProtocol: TREASURY_MARKER_EXACT_PROTOCOL,
    identityProfile: "lowlevel",
    authorityClass: "lowlevel",
    lowlevelSource: "runtime-lowlevel@v1",
    durableIdentityDigest: "0cc99174bb6f2e74",
    ...overrides,
  } as never);
}

/** quarantine authority + final not-executed tombstone + journal entry（gate 前置事实齐备——durable 以 authority 重算值为单一来源）。 */
function seedQuarantineAuthorityAndTombstone(transactionId: string): void {
  const write = quarantineTreasuryTransaction({
    transactionId,
    authorityLevel: "lowlevel",
    lowlevelSource: "runtime-lowlevel@v1",
    digest: DIGEST,
    tick: Game.time,
    kind: "terminal.send",
    actionKind: "terminal.send",
    source: "test",
    adapterSemanticIdentity: "terminal.send@reconciler-semantics-v1",
    phase: "executing_at_end_tick",
    outcome: "started_unknown",
    settlement: "quarantined",
    deltas: [{ roomName: "W1N57", locationKind: "storage" as const, resource: "energy" as const, delta: -500 }],
    recordedAt: Game.time,
  });
  expect(write.status).toBe("written");
  const durable = readTreasuryQuarantineEntry(transactionId)?.durableIdentityDigest;
  expect(durable).toBeDefined();
  const tombstone = writeTreasuryResolutionTombstone({
    transactionId,
    digest: DIGEST,
    resolution: "not-executed",
    stage: "final",
    proofLevel: "lowlevel",
    lowlevelSource: "runtime-lowlevel@v1",
    durableIdentityDigest: durable,
    actionTick: Game.time,
    observationTick: Game.time,
    resolvedAtTick: Game.time,
    reconcilerKind: "terminal.send",
    source: "test",
  });
  expect(tombstone.status).not.toBe("rejected");
  const opened = openTreasuryResolutionCleanup({
    transactionId,
    digest: DIGEST,
    resolution: "not-executed",
    identityProfile: "lowlevel",
    proofClass: "lowlevel",
    lowlevelSource: "runtime-lowlevel@v1",
    durableIdentityDigest: durable,
  });
  expect(opened.status).toBe("opened");
  // 【Remediation V 九】open 只创建 reservation——proof activation 是唯一
  // false→true 写入口（tombstone 已持久，activation 验证通过）。
  const activation = acknowledgeTreasuryCleanupSettlementProof({ transactionId });
  expect(activation.outcome === "activated" || activation.outcome === "already_activated").toBe(true);
}

const lowlevelExpected = {
  transactionId: "r22_mk_tx",
  digest: DIGEST,
  proofClass: "lowlevel",
  identityProfile: "lowlevel" as const,
  lowlevelSource: "runtime-lowlevel@v1",
  durableIdentityDigest: "0cc99174bb6f2e74",
};

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryResolutionCleanupForTest();
});

describe("marker exact identity 与 discharge（第二十二轮第六节）", () => {
  it("absent → already_absent（当前 attempt discharged、全局未锁）", () => {
    const result = dischargeTreasuryMarkerForAttempt(lowlevelExpected);
    expect(result.outcome).toBe("already_absent");
    expect(result.attemptMarkerDischarged).toBe(true);
    expect(result.globalWriteAdmissionStillLocked).toBe(false);
    expect(treasuryMarkerDischargeCompletesAttemptPhase(result.outcome)).toBe(true);
  });

  it("matching v4 marker 清除 + read-back → matching_cleared", () => {
    seedV4Marker();
    const result = dischargeTreasuryMarkerForAttempt(lowlevelExpected);
    expect(result.outcome).toBe("matching_cleared");
    expect(readTreasuryWriteFault()).toBeUndefined();
  });

  it("unrelated marker（其它 transaction）→ 不删除、当前 attempt discharged、global lock 保留", () => {
    seedV4Marker({ transactionId: "r22_other_tx" });
    const result = dischargeTreasuryMarkerForAttempt(lowlevelExpected);
    expect(result.outcome).toBe("unrelated_global_lock");
    expect(result.attemptMarkerDischarged).toBe(true);
    expect(result.globalWriteAdmissionStillLocked).toBe(true);
    expect(readTreasuryWriteFault()?.transactionId).toBe("r22_other_tx");
  });

  it("同 transaction digest 冲突 → conflict（零状态变化）", () => {
    seedV4Marker({ digest: "ffffffffffffffff", durableIdentityDigest: "0cc99174bb6f2e74" });
    const result = dischargeTreasuryMarkerForAttempt(lowlevelExpected);
    expect(result.outcome).toBe("conflict");
    expect(readTreasuryWriteFault()).toBeDefined();
    expect(treasuryMarkerDischargeCompletesAttemptPhase("conflict")).toBe(false);
  });

  it("同 transaction durable 冲突 → conflict；lineageId 冲突 → conflict（显式链维度）", () => {
    seedV4Marker({ durableIdentityDigest: "aaaaaaaaaaaaaaaa" });
    expect(dischargeTreasuryMarkerForAttempt(lowlevelExpected).outcome).toBe("conflict");
    expect(
      treasuryMarkerExactIdentityRelation(
        { ...lowlevelExpected, lineageId: "1111111111111111", lineageGeneration: 1, parentTransactionId: "p", lineageBindingDigest: "b" },
        readTreasuryWriteFault(),
      ).kind,
    ).toBe("conflict");
  });

  it("v1 legacy marker 同 transaction → insufficient（fail closed 保留）", () => {
    recordTreasuryWriteFault({
      transactionId: "r22_mk_tx",
      digest: DIGEST,
      tick: Game.time,
      kind: "terminal.send",
      source: "test",
      phase: "executing_at_end_tick",
      status: "unresolved",
      recordedAt: Game.time,
    });
    expect(dischargeTreasuryMarkerForAttempt(lowlevelExpected).outcome).toBe("insufficient");
    expect(readTreasuryWriteFault()).toBeDefined();
  });

  it("v3 marker（markerVersion 3 + lineageId）按携带维度 match", () => {
    recordTreasuryWriteFault({
      transactionId: "tr1_1111111111111111_000001_aaaaaaaa",
      digest: DIGEST,
      tick: Game.time,
      kind: "terminal.send",
      source: "test",
      phase: "executing_at_end_tick",
      status: "unresolved",
      recordedAt: Game.time,
      markerVersion: 3,
      authorityClass: "lowlevel",
      lowlevelSource: "runtime-lowlevel@v1",
      lineageId: "1111111111111111",
      attemptGeneration: 1,
      lineageBindingDigest: "bbbbbbbbbbbbbbbb",
    });
    const relation = treasuryMarkerExactIdentityRelation(
      {
        transactionId: "tr1_1111111111111111_000001_aaaaaaaa",
        digest: DIGEST,
        proofClass: "lowlevel",
        identityProfile: "lowlevel",
        lowlevelSource: "runtime-lowlevel@v1",
        lineageId: "1111111111111111",
        lineageGeneration: 1,
        lineageBindingDigest: "bbbbbbbbbbbbbbbb",
      },
      readTreasuryWriteFault(),
    );
    expect(relation.kind).toBe("match");
  });

  it("malformed marker → store_unhealthy（零状态变化）", () => {
    recordTreasuryWriteFault({ transactionId: "", digest: "xx" } as never);
    expect(dischargeTreasuryMarkerForAttempt(lowlevelExpected).outcome).toBe("store_unhealthy");
  });
});

describe("resolution cleanup journal（第二十二轮第七节）", () => {
  it("open → 阶段推进 → 全完成删除（journal 即持久 pending 索引）", () => {
    expect(openTreasuryResolutionCleanup({ ...lowlevelExpected, resolution: "not-executed", digest: DIGEST, proofClass: "lowlevel", identityProfile: "lowlevel" }).status).toBe("opened");
    // 【Remediation V 九】open 恒 reservation——直接 mark 阶段被偏序拒绝
    //（proof activation 是唯一激活入口）；测试经 activation 权威激活后推进。
    expect(markTreasuryResolutionCleanupStage("r22_mk_tx", "marker_discharge", "matching_cleared")).toBe(false);
    const store = (Memory.runtime as { treasury?: { resolutionCleanup?: { entries?: Record<string, { settlementProofDurable?: boolean }> } } }).treasury?.resolutionCleanup;
    store!.entries!["c:r22_mk_tx"]!.settlementProofDurable = true;
    expect(listTreasuryResolutionCleanupPendingIds()).toContain("r22_mk_tx");
    expect(markTreasuryResolutionCleanupStage("r22_mk_tx", "marker_discharge", "matching_cleared")).toBe(true);
    expect(markTreasuryResolutionCleanupStage("r22_mk_tx", "authority_release")).toBe(true);
    expect(markTreasuryResolutionCleanupStage("r22_mk_tx", "outcome_finalization")).toBe(true);
    expect(readTreasuryResolutionCleanupEntry("r22_mk_tx")?.lineageFinalized).toBe(false);
    expect(completeTreasuryResolutionCleanup("r22_mk_tx")).toBe(false);
    expect(markTreasuryResolutionCleanupStage("r22_mk_tx", "lineage_finalization")).toBe(true);
    expect(completeTreasuryResolutionCleanup("r22_mk_tx")).toBe(true);
    expect(listTreasuryResolutionCleanupPendingIds()).not.toContain("r22_mk_tx");
  });

  it("同 attempt 两种结论 → conflict；同结论重开幂等", () => {
    openTreasuryResolutionCleanup({ ...lowlevelExpected, resolution: "not-executed", digest: DIGEST, proofClass: "lowlevel", identityProfile: "lowlevel" });
    const conflict = openTreasuryResolutionCleanup({ ...lowlevelExpected, resolution: "committed", digest: DIGEST, proofClass: "lowlevel", identityProfile: "lowlevel" });
    expect(conflict.status).toBe("conflict");
    // 【Remediation V 九】open 不激活——未激活 entry 的 reopen 恒 reservation。
    expect(openTreasuryResolutionCleanup({ ...lowlevelExpected, resolution: "not-executed", digest: DIGEST, proofClass: "lowlevel", identityProfile: "lowlevel" }).status).toBe("already_open_reservation");
  });

  it("handlers 未装配 → 恢复 fail closed 保留 pending；global reset 后 journal 重建", () => {
    openTreasuryResolutionCleanup({ ...lowlevelExpected, resolution: "not-executed", digest: DIGEST, proofClass: "lowlevel", identityProfile: "lowlevel" });
    registerTreasuryResolutionCleanupHandlersForAssembly(null);
    const report = recoverTreasuryResolutionCleanupAtTickBoundary();
    expect(report.blocked).toBeGreaterThanOrEqual(1);
    expect(listTreasuryResolutionCleanupPendingIds()).toContain("r22_mk_tx");
    // global reset（heap 清空）后 journal 从 Memory 重建。
    resetTreasuryResolutionCleanupForTest();
    openTreasuryResolutionCleanup({ ...lowlevelExpected, resolution: "not-executed", digest: DIGEST, proofClass: "lowlevel", identityProfile: "lowlevel" });
    expect(listTreasuryResolutionCleanupPendingIds()).toContain("r22_mk_tx");
  });

  it("handlers 装配 + 空 marker → 恢复推进 marker discharge 阶段", () => {
    seedQuarantineAuthorityAndTombstone("r22_mk_tx");
    // 【Remediation V 七】root not-executed 的 pre-release gate 要求 root
    // lineage exact relation 成立——seed matching root lineage（converge 到
    // non_rearmable_retired 终态）。
    const durable = readTreasuryQuarantineEntry("r22_mk_tx")?.durableIdentityDigest;
    const { convergeTreasuryLineageRetirementFromFacts } =
      jest.requireActual("@/runtime/treasury/attemptLineage") as typeof import("@/runtime/treasury/attemptLineage");
    const rootLineage = createTreasuryAttemptLineageRecord({
      rootTransactionId: "r22_mk_tx",
      rootIdentity: { digest: DIGEST, durableIdentityDigest: durable, lowlevelSource: "runtime-lowlevel@v1" },
      actionKind: "terminal.send",
      authorityClass: "lowlevel",
      lowlevelSource: "runtime-lowlevel@v1",
      rearmable: false,
      identityProfile: "lowlevel",
      nonRearmReason: "test fixture",
    });
    expect(rootLineage.status).toBe("written");
    if (rootLineage.status === "rejected") throw new Error("seed rejected");
    registerTreasuryResolutionCleanupHandlersForAssembly({
      authorityRelease: () => ({ status: "blocked", detail: "authority 仍存在（本用例只验证 discharge 阶段）" }),
      outcomeFinalization: () => ({ status: "blocked", detail: "pending" }),
      lineageFinalization: () => ({ status: "blocked", detail: "pending" }),
    });
    const report = recoverTreasuryResolutionCleanupAtTickBoundary();
    expect(report.examined).toBeGreaterThanOrEqual(1);
    expect(readTreasuryResolutionCleanupEntry("r22_mk_tx")?.markerDischarged).toBe(true);
  });
});

describe("release-trusted receipt 分离（第二十二轮第八节）", () => {
  it("不存在 → absent；store 损坏 → store_unhealthy（绝不 trusted）", () => {
    // 【XII/D】trusted lookup 零写——absent 分支不再隐式创建 Memory 分支。
    const runtimeBefore = (Memory.runtime as { treasury?: unknown } | undefined)?.treasury;
    expect(lookupTreasuryTrustedSettledReceipt("r22_absent_tx").status).toBe("absent");
    expect((Memory.runtime as { treasury?: unknown } | undefined)?.treasury).toBe(runtimeBefore);
    if (!Memory.runtime) Memory.runtime = {} as never;
    (Memory.runtime as unknown as { treasury?: { receipts?: unknown } }).treasury = {
      receipts: { version: 999, settled: {}, entryCount: 0, nextExpiryTick: null },
    };
    clearTreasuryPersistenceForTest();
    (Memory.runtime as unknown as { treasury?: { receipts?: unknown } }).treasury = {
      receipts: { version: 999, settled: {}, entryCount: 0, nextExpiryTick: null },
    };
    expect(lookupTreasuryTrustedSettledReceipt("r22_absent_tx").status).toBe("store_unhealthy");
  });
});

describe("purpose-aware semantic lineage（第二十二轮第十节）", () => {
  it("缺 purpose → fail closed（store_unhealthy，不乐观验证）", () => {
    const verdict = validateTreasurySemanticLineage({
      transactionId: "tr1_1111111111111111_000001_aaaaaaaa",
      proof: { lineageId: "1111111111111111", lineageGeneration: 1, parentTransactionId: "p", lineageBindingDigest: "b" },
    } as never);
    expect(verdict.verdict).toBe("store_unhealthy");
  });

  it("非 tr1_ 输入 → conflict（initial 无 lineage 语义域）", () => {
    const verdict = validateTreasurySemanticLineage({
      transactionId: "r22_initial",
      proof: { lineageId: "1111111111111111", lineageGeneration: 1, parentTransactionId: "p", lineageBindingDigest: "b" },
      purpose: "committed_settlement",
    });
    expect(verdict.verdict).toBe("conflict");
  });
});

describe("identity profile 矩阵（第二十二轮第十一节）", () => {
  it("modern-contract required/forbidden 矩阵", () => {
    const full = { digest: DIGEST, contractDigest: "c000000000000001", authorizationCohortDigest: "d000000000000001", durableIdentityDigest: "e000000000000001" };
    expect(validateTreasuryIdentityProfileFacts("modern-contract", full)).toBeNull();
    expect(validateTreasuryIdentityProfileFacts("modern-contract", { ...full, contractDigest: undefined })).toContain("required");
    expect(validateTreasuryIdentityProfileFacts("modern-contract", { ...full, lowlevelSource: "runtime-lowlevel@v1" })).toContain("forbidden");
    expect(treasuryIdentityProfileOfFacts(full)).toBe("modern-contract");
  });

  it("lowlevel 矩阵与 partial fail closed", () => {
    expect(validateTreasuryIdentityProfileFacts("lowlevel", { digest: DIGEST, durableIdentityDigest: "e000000000000001", lowlevelSource: "runtime-lowlevel@v1" })).toBeNull();
    expect(validateTreasuryIdentityProfileFacts("lowlevel", { digest: DIGEST, durableIdentityDigest: "e000000000000001", contractDigest: "c000000000000001", lowlevelSource: "runtime-lowlevel@v1" })).toContain("forbidden");
    // contract XOR cohort → partial → null（迁移 fail closed）。
    expect(treasuryIdentityProfileOfFacts({ digest: DIGEST, contractDigest: "c000000000000001" })).toBeNull();
    // digest+durable 无 contract/cohort → legacy-replay（不自动获得权限）。
    expect(treasuryIdentityProfileOfFacts({ digest: DIGEST, durableIdentityDigest: "e000000000000001" })).toBe("legacy-replay");
  });

  it("legacy-replay / forensic-isolated 不参与自动协议", () => {
    expect(treasuryProfileAllowsAutomaticProtocol("legacy-replay")).toBe(false);
    expect(treasuryProfileAllowsAutomaticProtocol("forensic-isolated")).toBe(false);
    expect(treasuryProfileAllowsAutomaticProtocol("modern-contract")).toBe(true);
  });
});
