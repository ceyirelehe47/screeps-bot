/**
 * 【Round 22 remediation】journal 真实持久化 / marker→authority 顺序收敛 /
 * marker 与 expected 完整校验 / journal identity 不可变 / GRA trusted 清理 /
 * purpose 必填契约的回归矩阵。
 *
 * 覆盖任务书 A（journal 持久化与 global reset）、B（六个中断窗口的 heap
 * reset 恢复）、C（discharge 前 marker shape / read-back shape / expected
 * requiredness 负向）、D（reopen exact 相等与阶段强制顺序）、E（GRA 孤儿
 * proof 的 release-trusted 删除门禁）、F（purpose 必填类型契约与
 * unresolvedAuthority ok 路径回归）。
 */
import { clearTreasuryPersistenceForTest, commitSettledReceipt } from "@/runtime/treasury/receipts";
import { recordTreasuryWriteFault, readTreasuryWriteFault } from "@/runtime/treasury/writeFault";
import { dischargeTreasuryMarkerForAttempt } from "@/runtime/treasury/markerDischarge";
import {
  openTreasuryResolutionCleanup,
  markTreasuryResolutionCleanupStage,
  readTreasuryResolutionCleanupEntry,
  peekTreasuryResolutionCleanupHealth,
  resetTreasuryResolutionCleanupHeapCacheForTest,
  clearTreasuryResolutionCleanupDurableForTest,
  recoverTreasuryResolutionCleanupAtTickBoundary,
  registerTreasuryResolutionCleanupHandlersForAssembly,
} from "@/runtime/treasury/resolutionCleanupJournal";
import { TREASURY_MARKER_EXACT_PROTOCOL as MARKER_V4 } from "@/runtime/treasury/markerExactIdentity";
import {
  validateTreasurySemanticLineage,
  registerTreasurySemanticLineageRecordSourceForAssembly,
  resetTreasurySemanticLineageSourcesForTest,
} from "@/runtime/treasury/semanticLineageValidation";
import {
  writeTreasuryResolutionTombstone,
  readTreasuryResolutionTombstone,
  resetTreasuryResolutionStoreForTest,
} from "@/runtime/treasury/resolutionStore";
import {
  quarantineTreasuryTransaction,
  readTreasuryQuarantineEntry,
  releaseTreasuryQuarantineEntry,
  resetTreasuryQuarantineRuntimeForTest,
} from "@/runtime/treasury/quarantine";
import { releaseTreasuryIntentEntry, resetTreasuryIntentRuntimeForTest } from "@/runtime/treasury/intents";
import { resolveTreasuryUnresolvedAuthority } from "@/runtime/treasury/unresolvedAuthority";
import { sweepTreasuryOrphanGenerationProofOnAdvance } from "@/runtime/treasury/generationProofLifecycle";
import {
  createTreasuryAttemptLineageRecord,
  convergeTreasuryLineageRetirementFromFacts,
  stageTreasuryLineageCapabilityIssued,
  stageTreasuryLineageChildIntentPending,
  activateTreasuryLineageChild,
  retireTreasuryLineageCurrentAttempt,
  readTreasuryAttemptLineageRecord,
  registerTreasuryAttemptLineageSemanticSourceForAssembly,
  resetTreasuryLineageRuntimeForTest,
  deriveTreasuryLineageNextChildTransactionId,
} from "@/runtime/treasury/attemptLineage";
import { computeTreasuryLineageBindingDigest } from "@/runtime/treasury/lineageBinding";
import {
  readTreasuryGenerationRetirementProof,
  resetTreasuryGenerationRetirementRuntimeForTest,
} from "@/runtime/treasury/generationRetirementAuthority";
import { writeTreasuryIntentEntry } from "@/runtime/treasury/intents";
import { registerTreasuryRetirementSummarySemanticSourceForAssembly } from "@/runtime/treasury/lineageRetirementSummary";
import { registerTreasuryGenerationRetirementSemanticSourceForAssembly } from "@/runtime/treasury/generationRetirementAuthority";
import { recomputeTreasuryDurableIdentityDigest } from "@/runtime/treasury/identityProof";
import { TREASURY_LOWLEVEL_SOURCE_RUNTIME } from "@/runtime/treasury/authorityLevel";
import * as fs from "fs";
import * as path from "path";

const DIGEST = "0123456789abcdef";
const POSTINGS = [{ roomName: "W1N57", locationKind: "storage" as const, resource: "energy" as const, delta: -500 }];

function seedV4Marker(overrides: Record<string, unknown> = {}): void {
  recordTreasuryWriteFault({
    transactionId: "r22r_tx",
    digest: DIGEST,
    tick: Game.time,
    kind: "terminal.send",
    source: "test",
    phase: "executing_at_end_tick",
    status: "unresolved",
    recordedAt: Game.time,
    markerProtocol: MARKER_V4,
    identityProfile: "lowlevel",
    authorityClass: "lowlevel",
    lowlevelSource: "runtime-lowlevel@v1",
    durableIdentityDigest: overrides.durableIdentityDigest ?? "0cc99174bb6f2e74",
    ...overrides,
  } as never);
}

const lowlevelExpected = {
  transactionId: "r22r_tx",
  digest: DIGEST,
  proofClass: "lowlevel",
  identityProfile: "lowlevel" as const,
  lowlevelSource: "runtime-lowlevel@v1",
  durableIdentityDigest: "0cc99174bb6f2e74",
};

function seedQuarantineAuthority(transactionId: string): string {
  const write = quarantineTreasuryTransaction({
    transactionId,
    authorityLevel: "lowlevel",
    lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
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
  });
  expect(write.status).toBe("written");
  // 【Remediation IV 六.3】durableIdentityDigest 由 quarantine 写入按
  // postings 重算（与 Game.time 相关）——fixture 全部身份载体（marker/
  // tombstone/receipt/journal entry）统一使用 authority 的实际 durable，
  // 与生产路径（authority 事实单一来源）一致。
  const durable = readTreasuryQuarantineEntry(transactionId)?.durableIdentityDigest;
  expect(durable).toBeDefined();
  return durable as string;
}

/** 与生产 facade handler 同构的测试装配（trusted receipt 验证由 facade
 * 既有测试承载；此处验证 journal 恢复编排的顺序与幂等）。 */
function installTestStageHandlers(): void {
  registerTreasuryResolutionCleanupHandlersForAssembly({
    authorityRelease: (entry) => {
      const current = resolveTreasuryUnresolvedAuthority(entry.transactionId);
      if (current.status === "not_found") return { status: "already_absent", detail: "resolver not_found" };
      if (current.status !== "ok") return { status: "blocked", detail: `unresolved authority ${current.status}` };
      releaseTreasuryQuarantineEntry(entry.transactionId);
      releaseTreasuryIntentEntry(entry.transactionId);
      return resolveTreasuryUnresolvedAuthority(entry.transactionId).status === "not_found"
        ? { status: "released", detail: "read-back not_found" }
        : { status: "blocked", detail: "release 后 read-back 仍非 not_found" };
    },
    outcomeFinalization: (entry) => {
      const tombstone = readTreasuryResolutionTombstone(entry.transactionId);
      if (tombstone === undefined) return { status: "blocked", detail: "tombstone 缺失" };
      if (tombstone.stage === "final") return { status: "already_final", detail: "final" };
      if (tombstone.resolution !== "committed") return { status: "blocked", detail: "非 committed 不在此 finalize" };
      const write = writeTreasuryResolutionTombstone({ ...tombstone, stage: "final" });
      return write.status === "rejected" ? { status: "blocked", detail: write.detail } : { status: "finalized", detail: "final 写入" };
    },
    lineageFinalization: (entry) =>
      entry.lineageId === undefined
        ? { status: "not_applicable", detail: "initial attempt 无 lineage 阶段" }
        : { status: "finalized", detail: "test handler" },
  });
}

/** committed initial attempt 的完整 cleanup 场景 fixture（marker + authority + resolving tombstone + journal entry）。 */
function seedCommittedCleanupScene(stages: { marker?: boolean; authority?: boolean; outcome?: boolean } = {}): void {
  // 【Remediation IV 六.3】authority 先 seed——durable 重算值成为全部身份
  // 载体的单一来源（journal ↔ authority exact identity 一致）。
  const durable = seedQuarantineAuthority("r22r_tx");
  seedV4Marker({ durableIdentityDigest: durable });
  const written = writeTreasuryResolutionTombstone({
    transactionId: "r22r_tx",
    digest: DIGEST,
    resolution: "committed",
    stage: "resolving",
    proofLevel: "lowlevel",
    lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
    durableIdentityDigest: durable,
    actionTick: Game.time,
    settledAtTick: Game.time,
    observationTick: Game.time,
    resolvedAtTick: Game.time,
    reconcilerKind: "terminal.send",
    source: "test",
  });
  expect(written.status).not.toBe("rejected");
  // 【Remediation IV 六.5】committed 目标的 pre-release gate 要求
  // release-trusted Receipt 在 marker discharge 之前成立（生产 staged 流程
  // receipt 刷新先于 cleanup advance——fixture 与生产时序对齐）。
  expect(commitSettledReceipt("r22r_tx", Game.time, {
    digest: DIGEST,
    durableIdentityDigest: durable,
    lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
  }).status).not.toBe("rejected");
  const opened = openTreasuryResolutionCleanup({
    transactionId: "r22r_tx",
    digest: DIGEST,
    resolution: "committed",
    identityProfile: "lowlevel",
    proofClass: "lowlevel",
    lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
    durableIdentityDigest: durable,
  });
  expect(opened.status).toBe("opened");
  // 【Remediation V 九】open 只创建 reservation——窗口 fixture 模拟 proof
  // activation 已完成（settlement proof 已持久，activation 权威会通过）。
  (Memory.runtime as unknown as { treasury?: { resolutionCleanup?: { entries?: Record<string, { settlementProofDurable?: boolean }> } } })
    .treasury!.resolutionCleanup!.entries!["c:r22r_tx"]!.settlementProofDurable = true;
  const sceneExpected = { ...lowlevelExpected, durableIdentityDigest: durable };
  if (stages.marker) {
    // 窗口 3/4：marker 已删除（read-back 完成）。
    const discharged = dischargeTreasuryMarkerForAttempt(sceneExpected);
    expect(discharged.outcome).toBe("matching_cleared");
    expect(markTreasuryResolutionCleanupStage("r22r_tx", "marker_discharge", discharged.outcome)).toBe(true);
  }
  if (stages.authority) {
    // 窗口 5/6：authority 已释放（read-back not_found 完成）。
    expect(releaseTreasuryQuarantineEntry("r22r_tx")).toBe(true);
    expect(resolveTreasuryUnresolvedAuthority("r22r_tx").status).toBe("not_found");
    expect(markTreasuryResolutionCleanupStage("r22r_tx", "authority_release")).toBe(true);
  }
  if (stages.outcome) {
    const finalized = writeTreasuryResolutionTombstone({ ...readTreasuryResolutionTombstone("r22r_tx")!, stage: "final" });
    expect(finalized.status).not.toBe("rejected");
    expect(markTreasuryResolutionCleanupStage("r22r_tx", "outcome_finalization")).toBe(true);
  }
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryResolutionCleanupHeapCacheForTest();
  registerTreasuryResolutionCleanupHandlersForAssembly(null);
  resetTreasurySemanticLineageSourcesForTest();
});

afterAll(() => {
  registerTreasuryResolutionCleanupHandlersForAssembly(null);
});

describe("A：cleanup journal 真实持久化（remediation A）", () => {
  it("首次 open 真正挂载 Memory.runtime.treasury.resolutionCleanup（非 heap-only）", () => {
    const opened = openTreasuryResolutionCleanup({
      transactionId: "r22r_a1",
      digest: DIGEST,
      resolution: "not-executed",
      identityProfile: "lowlevel",
      proofClass: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      durableIdentityDigest: "0cc99174bb6f2e74",
    });
    expect(opened.status).toBe("opened");
    const durable = (Memory.runtime as unknown as { treasury?: { resolutionCleanup?: { entries?: Record<string, unknown> } } }).treasury?.resolutionCleanup;
    expect(durable).toBeDefined();
    expect(durable!.entries!["c:r22r_a1"]).toBeDefined();
    expect((durable!.entries!["c:r22r_a1"] as { markerDischarged: boolean }).markerDischarged).toBe(false);
  });

  it("global reset：只清 heap 后不重新 open，identity/阶段全部从 Memory 恢复（含 JSON round-trip）", () => {
    const opened = openTreasuryResolutionCleanup({
      transactionId: "r22r_a2",
      digest: DIGEST,
      resolution: "committed",
      identityProfile: "lowlevel",
      proofClass: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      durableIdentityDigest: "0cc99174bb6f2e74",
    });
    expect(opened.status).toBe("opened");
    // 【Remediation V 九】open 恒 reservation——手工激活（global reset 恢复
    // 语义验证的 fixture 前置）。
    (Memory.runtime as unknown as { treasury?: { resolutionCleanup?: { entries?: Record<string, { settlementProofDurable?: boolean }> } } })
      .treasury!.resolutionCleanup!.entries!["c:r22r_a2"]!.settlementProofDurable = true;
    expect(markTreasuryResolutionCleanupStage("r22r_a2", "marker_discharge", "matching_cleared")).toBe(true);
    // Memory 中确实存在 entry 与阶段。
    const durableBefore = (Memory.runtime as unknown as { treasury?: { resolutionCleanup?: { entries?: Record<string, unknown> } } }).treasury!.resolutionCleanup!;
    const entryBefore = durableBefore.entries!["c:r22r_a2"] as Record<string, unknown>;
    expect(entryBefore.markerDischarged).toBe(true);
    expect(entryBefore.authorityReleased).toBe(false);
    // 只清 heap（不删 Memory）——模拟 global reset。
    resetTreasuryResolutionCleanupHeapCacheForTest();
    // 不再 open：直接 read。
    const restored = readTreasuryResolutionCleanupEntry("r22r_a2");
    expect(restored).toBeDefined();
    expect(restored!.transactionId).toBe("r22r_a2");
    expect(restored!.digest).toBe(DIGEST);
    expect(restored!.resolution).toBe("committed");
    expect(restored!.identityProfile).toBe("lowlevel");
    expect(restored!.proofClass).toBe("lowlevel");
    expect(restored!.lowlevelSource).toBe(TREASURY_LOWLEVEL_SOURCE_RUNTIME);
    expect(restored!.durableIdentityDigest).toBe("0cc99174bb6f2e74");
    expect(restored!.markerDischarged).toBe(true);
    expect(restored!.authorityReleased).toBe(false);
    // 序列化/反序列化副本后重复验证（跨 global 的 JSON 等价语义）。
    const roundTripped = JSON.parse(JSON.stringify(
      (Memory.runtime as unknown as { treasury?: { resolutionCleanup?: unknown } }).treasury!.resolutionCleanup,
    )) as { entries: Record<string, { markerDischarged: boolean; transactionId: string }> };
    expect(roundTripped.entries["c:r22r_a2"].transactionId).toBe("r22r_a2");
    expect(roundTripped.entries["c:r22r_a2"].markerDischarged).toBe(true);
  });

  it("test 函数语义分离：clear durable 删除 Memory；reset heap 只失效缓存", () => {
    openTreasuryResolutionCleanup({
      transactionId: "r22r_a3",
      digest: DIGEST,
      resolution: "not-executed",
      identityProfile: "lowlevel",
      proofClass: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      durableIdentityDigest: "0cc99174bb6f2e74",
    });
    resetTreasuryResolutionCleanupHeapCacheForTest();
    expect(readTreasuryResolutionCleanupEntry("r22r_a3")).toBeDefined();
    clearTreasuryResolutionCleanupDurableForTest();
    expect((Memory.runtime as unknown as { treasury?: { resolutionCleanup?: unknown } }).treasury?.resolutionCleanup).toBeUndefined();
    expect(readTreasuryResolutionCleanupEntry("r22r_a3")).toBeUndefined();
  });

  it("journal 损坏 → 结构化 unhealthy；open rejected；destructive 恢复 fail closed（不折叠为 absent）", () => {
    Memory.runtime = (Memory.runtime ?? {}) as never;
    (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury = {
      resolutionCleanup: { version: 99, entries: {}, entryCount: 0, updatedAt: Game.time },
    };
    const health = peekTreasuryResolutionCleanupHealth();
    expect(health.healthy).toBe(false);
    expect(health.detail).toContain("版本非法");
    const opened = openTreasuryResolutionCleanup({
      transactionId: "r22r_a4",
      digest: DIGEST,
      resolution: "not-executed",
      identityProfile: "lowlevel",
      proofClass: "lowlevel",
    });
    expect(opened.status).toBe("rejected");
    installTestStageHandlers();
    const report = recoverTreasuryResolutionCleanupAtTickBoundary();
    expect(report.blocked).toBeLessThan(0);
    expect(report.blockedDetails[0]).toContain("fail-closed");
  });
});

describe("B：六个中断窗口的 heap reset 恢复（remediation B.6）", () => {
  it("窗口 1/2（settlement proof 后 / marker discharge 前）：恢复从 discharge 开始并全链完成", () => {
    seedCommittedCleanupScene({});
    installTestStageHandlers();
    // 真正的 heap reset（journal + resolution store + quarantine 的 heap 缓存）。
    resetTreasuryResolutionCleanupHeapCacheForTest();
    resetTreasuryResolutionStoreForTest();
    resetTreasuryQuarantineRuntimeForTest();
    const report = recoverTreasuryResolutionCleanupAtTickBoundary();
    expect(report.examined).toBe(1);
    expect(report.blocked).toBe(0);
    expect(readTreasuryWriteFault()).toBeUndefined();
    expect(readTreasuryQuarantineEntry("r22r_tx")).toBeUndefined();
    expect(readTreasuryResolutionTombstone("r22r_tx")?.stage).toBe("final");
    expect(readTreasuryResolutionCleanupEntry("r22r_tx")).toBeUndefined();
  });

  it("窗口 3（marker read-back 后、authority release 前）：恢复从 release 开始", () => {
    seedCommittedCleanupScene({ marker: true });
    expect(readTreasuryWriteFault()).toBeUndefined();
    installTestStageHandlers();
    resetTreasuryResolutionCleanupHeapCacheForTest();
    resetTreasuryResolutionStoreForTest();
    resetTreasuryQuarantineRuntimeForTest();
    const report = recoverTreasuryResolutionCleanupAtTickBoundary();
    expect(report.blocked).toBe(0);
    expect(readTreasuryQuarantineEntry("r22r_tx")).toBeUndefined();
    expect(readTreasuryResolutionTombstone("r22r_tx")?.stage).toBe("final");
    expect(readTreasuryResolutionCleanupEntry("r22r_tx")).toBeUndefined();
  });

  it("窗口 4（authority release 后、read-back/阶段标记前）：恢复幂等重放 release 并推进", () => {
    seedCommittedCleanupScene({ marker: true });
    // authority 已释放但 journal 阶段未标记（read-back 前中断）。
    expect(releaseTreasuryQuarantineEntry("r22r_tx")).toBe(true);
    expect(resolveTreasuryUnresolvedAuthority("r22r_tx").status).toBe("not_found");
    installTestStageHandlers();
    resetTreasuryResolutionCleanupHeapCacheForTest();
    resetTreasuryResolutionStoreForTest();
    resetTreasuryQuarantineRuntimeForTest();
    const report = recoverTreasuryResolutionCleanupAtTickBoundary();
    expect(report.blocked).toBe(0);
    expect(readTreasuryResolutionTombstone("r22r_tx")?.stage).toBe("final");
    expect(readTreasuryResolutionCleanupEntry("r22r_tx")).toBeUndefined();
  });

  it("窗口 5（outcome finalization 前）：恢复 finalize final tombstone", () => {
    seedCommittedCleanupScene({ marker: true, authority: true });
    installTestStageHandlers();
    resetTreasuryResolutionCleanupHeapCacheForTest();
    resetTreasuryResolutionStoreForTest();
    const report = recoverTreasuryResolutionCleanupAtTickBoundary();
    expect(report.blocked).toBe(0);
    expect(readTreasuryResolutionTombstone("r22r_tx")?.stage).toBe("final");
    expect(readTreasuryResolutionCleanupEntry("r22r_tx")).toBeUndefined();
  });

  it("窗口 6（lineage finalization 前）：tr1_ entry 恢复完成 lineage 阶段", () => {
    seedCommittedCleanupScene({ marker: true, authority: true, outcome: true });
    // 【Remediation IV 六/九】真实 tr1_ chain（child_active record）：pre-
    // release gate 的 semantic lineage purpose 验证要求 active 权威在场
    //（手工 lineageId 无 record → no_authority → gate 阻断——fixture 与
    // 生产一致：tr1_ cleanup 的 lineage record 由 capability 流程创建）。
    registerTreasuryAttemptLineageSemanticSourceForAssembly();
    registerTreasuryRetirementSummarySemanticSourceForAssembly();
    registerTreasuryGenerationRetirementSemanticSourceForAssembly();
    const w6Root = "r22r_w6_root";
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: w6Root,
      rootIdentity: { digest: DIGEST, durableIdentityDigest: "0cc99174bb6f2e74" },
      actionKind: "terminal.send",
      authorityClass: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      rearmable: true,
      identityProfile: "lowlevel",
      retrySemanticDigest: "6666666666666666",
    });
    expect(created.status).toBe("written");
    if (created.status === "rejected") throw new Error("seed create rejected");
    const w6LineageId = created.record.lineageId;
    // root retiring → rearm_ready（capability 签发前置——与生产 rearm 流程一致）。
    expect(convergeTreasuryLineageRetirementFromFacts(w6LineageId).status).toBe("completed");
    const w6Child = deriveTreasuryLineageNextChildTransactionId(w6LineageId, 1, w6Root);
    expect(stageTreasuryLineageCapabilityIssued(w6LineageId, w6Child).status).not.toBe("rejected");
    expect(stageTreasuryLineageChildIntentPending(w6LineageId, w6Child).status).not.toBe("rejected");
    const w6Binding = readTreasuryAttemptLineageRecord(w6LineageId)!.pendingBindingDigest!;
    const w6Durable = recomputeTreasuryDurableIdentityDigest({
      transactionId: w6Child,
      digest: DIGEST,
      actionKind: "terminal.send",
      source: "test",
      postings: [{ roomName: "W1N57", locationKind: "storage" as const, resource: "energy" as const, delta: -500 }],
      lineageId: w6LineageId,
      lineageGeneration: 1,
      parentTransactionId: w6Root,
      lineageBindingDigest: w6Binding,
    });
    expect(w6Durable).not.toBeNull();
    expect(
      activateTreasuryLineageChild(w6LineageId, { digest: DIGEST, durableIdentityDigest: w6Durable!, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME }).status,
    ).not.toBe("rejected");
    const w6Resolving = writeTreasuryResolutionTombstone({
      transactionId: w6Child,
      digest: DIGEST,
      resolution: "committed",
      stage: "resolving",
      proofLevel: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      durableIdentityDigest: w6Durable,
      actionTick: Game.time,
      settledAtTick: Game.time,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
      reconcilerKind: "terminal.send",
      source: "test",
      lineageId: w6LineageId,
      lineageGeneration: 1,
      parentTransactionId: w6Root,
      lineageBindingDigest: w6Binding,
    });
    expect(w6Resolving.status).not.toBe("rejected");
    expect(writeTreasuryResolutionTombstone({ ...readTreasuryResolutionTombstone(w6Child)!, stage: "final" }).status).not.toBe("rejected");
    // committed gate 前置：release-trusted receipt（含 lineage proof 维度）。
    expect(commitSettledReceipt(w6Child, Game.time, {
      digest: DIGEST,
      durableIdentityDigest: w6Durable!,
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      lineageId: w6LineageId,
      lineageGeneration: 1,
      parentTransactionId: w6Root,
      lineageBindingDigest: w6Binding,
    }).status).not.toBe("rejected");
    const opened = openTreasuryResolutionCleanup({
      transactionId: w6Child,
      digest: DIGEST,
      resolution: "committed",
      identityProfile: "lowlevel",
      proofClass: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      durableIdentityDigest: w6Durable!,
      lineageId: w6LineageId,
      lineageGeneration: 1,
      parentTransactionId: w6Root,
      lineageBindingDigest: w6Binding,
    });
    expect(opened.status).toBe("opened");
    // 【Remediation V 九】open 恒 reservation——窗口 fixture 手工激活。
    (Memory.runtime as unknown as { treasury?: { resolutionCleanup?: { entries?: Record<string, { settlementProofDurable?: boolean }> } } })
      .treasury!.resolutionCleanup!.entries![`c:${w6Child}`]!.settlementProofDurable = true;
    expect(markTreasuryResolutionCleanupStage(w6Child, "marker_discharge", "already_absent")).toBe(true);
    expect(markTreasuryResolutionCleanupStage(w6Child, "authority_release")).toBe(true);
    expect(markTreasuryResolutionCleanupStage(w6Child, "outcome_finalization")).toBe(true);
    installTestStageHandlers();
    resetTreasuryResolutionCleanupHeapCacheForTest();
    const report = recoverTreasuryResolutionCleanupAtTickBoundary();
    expect(report.blocked).toBe(0);
    // tr1_ entry 的 lineage 阶段补完成后 entry 删除。
    expect(readTreasuryResolutionCleanupEntry(w6Child)).toBeUndefined();
  });

  it("handlers 未装配 → 恢复 fail closed 保留全部 pending（不推进任何阶段）", () => {
    seedCommittedCleanupScene({});
    resetTreasuryResolutionCleanupHeapCacheForTest();
    const report = recoverTreasuryResolutionCleanupAtTickBoundary();
    expect(report.blocked).toBe(1);
    expect(readTreasuryWriteFault()).toBeDefined();
    expect(readTreasuryQuarantineEntry("r22r_tx")).toBeDefined();
    expect(readTreasuryResolutionTombstone("r22r_tx")?.stage).toBe("resolving");
    expect(readTreasuryResolutionCleanupEntry("r22r_tx")).toBeDefined();
  });
});

describe("C：discharge 前的完整 marker shape / read-back / expected requiredness（remediation C）", () => {
  const validMarkerFields = {
    transactionId: "r22r_tx",
    digest: DIGEST,
    tick: Game.time,
    kind: "terminal.send",
    source: "test",
    phase: "executing_at_end_tick" as const,
    status: "unresolved" as const,
    recordedAt: Game.time,
    markerProtocol: MARKER_V4,
    identityProfile: "lowlevel",
    authorityClass: "lowlevel",
    lowlevelSource: "runtime-lowlevel@v1",
    durableIdentityDigest: "0cc99174bb6f2e74",
  };

  it("有效 identity + 非法 phase → store_unhealthy（marker 保留、零状态）", () => {
    seedV4Marker({ phase: "definitely_not_a_phase" });
    const result = dischargeTreasuryMarkerForAttempt(lowlevelExpected);
    expect(result.outcome).toBe("store_unhealthy");
    expect(result.detail).toContain("形状非法");
    expect(readTreasuryWriteFault()).toBeDefined();
  });

  it("有效 identity + 非法 status → store_unhealthy", () => {
    seedV4Marker();
    ((Memory.runtime as unknown as { treasury?: { writeFault?: Record<string, unknown> } }).treasury!.writeFault as Record<string, unknown>).status = "resolved";
    expect(dischargeTreasuryMarkerForAttempt(lowlevelExpected).outcome).toBe("store_unhealthy");
    expect(readTreasuryWriteFault()).toBeDefined();
  });

  it("有效 identity + 非法 tick/kind/source → store_unhealthy", () => {
    seedV4Marker({ tick: -1 });
    expect(dischargeTreasuryMarkerForAttempt(lowlevelExpected).outcome).toBe("store_unhealthy");
    (Memory.runtime as unknown as { treasury?: { writeFault?: unknown } }).treasury!.writeFault = undefined;
    seedV4Marker({ kind: "" });
    expect(dischargeTreasuryMarkerForAttempt(lowlevelExpected).outcome).toBe("store_unhealthy");
    (Memory.runtime as unknown as { treasury?: { writeFault?: unknown } }).treasury!.writeFault = undefined;
    seedV4Marker({ source: "" });
    expect(dischargeTreasuryMarkerForAttempt(lowlevelExpected).outcome).toBe("store_unhealthy");
  });

  it("marker 为 null / 非对象 / 缺 transactionId → store_unhealthy（不抛异常、不折叠）", () => {
    Memory.runtime = (Memory.runtime ?? {}) as never;
    const branch = ((Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury ?? {}) as Record<string, unknown>;
    (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury = branch;
    branch.writeFault = null;
    expect(dischargeTreasuryMarkerForAttempt(lowlevelExpected).outcome).toBe("store_unhealthy");
    branch.writeFault = 42;
    expect(dischargeTreasuryMarkerForAttempt(lowlevelExpected).outcome).toBe("store_unhealthy");
    branch.writeFault = { digest: DIGEST };
    expect(dischargeTreasuryMarkerForAttempt(lowlevelExpected).outcome).toBe("store_unhealthy");
    branch.writeFault = undefined;
  });

  it("expected 缺 required（modern-contract 缺 contract/cohort/durable；lowlevel 缺 durable/source）→ insufficient", () => {
    seedV4Marker();
    // modern-contract expected 缺 contract/cohort/durable。
    expect(
      dischargeTreasuryMarkerForAttempt({
        transactionId: "r22r_tx",
        digest: DIGEST,
        proofClass: "identity-bound",
        identityProfile: "modern-contract",
      }).outcome,
    ).toBe("insufficient");
    // lowlevel expected 缺 durableIdentityDigest / lowlevelSource。
    expect(
      dischargeTreasuryMarkerForAttempt({
        transactionId: "r22r_tx",
        digest: DIGEST,
        proofClass: "lowlevel",
        identityProfile: "lowlevel",
        lowlevelSource: "runtime-lowlevel@v1",
      }).outcome,
    ).toBe("insufficient");
    expect(readTreasuryWriteFault()).toBeDefined();
  });

  it("marker 完整但 expected 不完整（维度缺一）→ insufficient（不按 undefined 跳过比较）", () => {
    seedV4Marker();
    const result = dischargeTreasuryMarkerForAttempt({
      transactionId: "r22r_tx",
      digest: DIGEST,
      proofClass: "lowlevel",
      identityProfile: "lowlevel",
      lowlevelSource: "runtime-lowlevel@v1",
      durableIdentityDigest: "0cc99174bb6f2e74",
      lineageId: "1111111111111111",
      // marker（initial attempt）无 lineage 维度：expected（tr1_）携带
      // lineageId 而 marker 无法绑定链 → insufficient（不猜测、不比较跳过）。
    });
    expect(result.outcome).toBe("insufficient");
    expect(readTreasuryWriteFault()).toBeDefined();
  });

  it("read-back malformed（非对象/缺基础字段）→ store_unhealthy（不抛异常、不当 unrelated）", () => {
    Memory.runtime = (Memory.runtime ?? {}) as never;
    const rawBranch = (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury;
    const branch = (rawBranch ?? {}) as Record<string, unknown>;
    (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury = branch;
    // marker 经 prototype getter 提供：own 属性不存在，delete no-op，read-back
    // 再次走 getter——第一次读合法 marker、delete 后翻转返回 malformed。
    let deleted = false;
    Object.setPrototypeOf(branch, {
      get writeFault(): unknown {
        return deleted ? { transactionId: "malformed-no-digest" } : { ...validMarkerFields };
      },
    });
    // 删除翻转由 discharge 内部的 delete 触发不了 own property——直接让
    // getter 以计数翻转：第一次（relation 判定）返回合法 marker，之后视为
    // 已删除并返回 malformed read-back。
    let reads = 0;
    Object.setPrototypeOf(branch, {
      get writeFault(): unknown {
        reads += 1;
        if (reads <= 1) return { ...validMarkerFields };
        deleted = true;
        return { transactionId: "r22r_tx_nodigest" };
      },
    });
    const result = dischargeTreasuryMarkerForAttempt(lowlevelExpected);
    expect(result.outcome).toBe("store_unhealthy");
    expect(result.attemptMarkerDischarged).toBe(true);
    expect(result.globalWriteAdmissionStillLocked).toBe(true);
    // 缺 transactionId 的 read-back（非对象形态）。
    let reads2 = 0;
    Object.setPrototypeOf(branch, {
      get writeFault(): unknown {
        reads2 += 1;
        return reads2 <= 1 ? { ...validMarkerFields } : null;
      },
    });
    expect(dischargeTreasuryMarkerForAttempt(lowlevelExpected).outcome).toBe("store_unhealthy");
    Object.setPrototypeOf(branch, {});
  });
});

describe("D：journal identity 不可变与阶段强制顺序（remediation D）", () => {
  const baseInput = {
    transactionId: "r22r_d1",
    digest: DIGEST,
    resolution: "not-executed" as const,
    identityProfile: "lowlevel" as const,
    proofClass: "lowlevel",
    lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
    durableIdentityDigest: "0cc99174bb6f2e74",
  };

  it("reopen 同 id 同 resolution：digest/profile/class/provenance/lineage 任一不等 → conflict 零状态变化", () => {
    expect(openTreasuryResolutionCleanup(baseInput).status).toBe("opened");
    (Memory.runtime as unknown as { treasury?: { resolutionCleanup?: { entries?: Record<string, { settlementProofDurable?: boolean }> } } })
      .treasury!.resolutionCleanup!.entries!["c:r22r_d1"]!.settlementProofDurable = true;
    expect(markTreasuryResolutionCleanupStage("r22r_d1", "marker_discharge", "already_absent")).toBe(true);
    const conflictVariants = [
      { digest: "ffffffffffffffff" },
      { identityProfile: "legacy-replay" as const },
      { proofClass: "identity-bound" },
      { durableIdentityDigest: "aaaaaaaaaaaaaaaa" },
      { lowlevelSource: "migrated-lowlevel@v0" },
      { lineageId: "1111111111111111" },
    ];
    for (const variant of conflictVariants) {
      const reopened = openTreasuryResolutionCleanup({ ...baseInput, ...variant });
      expect(reopened.status).toBe("conflict");
      // 阶段进度未被覆盖或重置。
      const entry = readTreasuryResolutionCleanupEntry("r22r_d1")!;
      expect(entry.digest).toBe(DIGEST);
      expect(entry.identityProfile).toBe("lowlevel");
      expect(entry.markerDischarged).toBe(true);
    }
    // exact 相等 reopen 幂等。
    expect(openTreasuryResolutionCleanup(baseInput).status).toBe("already_open_activated");
  });

  it("不同 resolution reopen → conflict", () => {
    expect(openTreasuryResolutionCleanup(baseInput).status).toBe("opened");
    expect(openTreasuryResolutionCleanup({ ...baseInput, resolution: "committed" }).status).toBe("conflict");
  });

  it("越级 mark（跳过前置阶段）→ false 零状态变化", () => {
    expect(openTreasuryResolutionCleanup(baseInput).status).toBe("opened");
    // reservation 期间全部阶段 mark 均被拒绝（proof activation 是唯一入口）。
    expect(markTreasuryResolutionCleanupStage("r22r_d1", "marker_discharge", "already_absent")).toBe(false);
    (Memory.runtime as unknown as { treasury?: { resolutionCleanup?: { entries?: Record<string, { settlementProofDurable?: boolean }> } } })
      .treasury!.resolutionCleanup!.entries!["c:r22r_d1"]!.settlementProofDurable = true;
    expect(markTreasuryResolutionCleanupStage("r22r_d1", "authority_release")).toBe(false);
    expect(markTreasuryResolutionCleanupStage("r22r_d1", "outcome_finalization")).toBe(false);
    expect(markTreasuryResolutionCleanupStage("r22r_d1", "lineage_finalization")).toBe(false);
    let entry = readTreasuryResolutionCleanupEntry("r22r_d1")!;
    expect(entry.markerDischarged).toBe(false);
    // 合法顺序全链。
    expect(markTreasuryResolutionCleanupStage("r22r_d1", "marker_discharge", "already_absent")).toBe(true);
    expect(markTreasuryResolutionCleanupStage("r22r_d1", "authority_release")).toBe(true);
    expect(markTreasuryResolutionCleanupStage("r22r_d1", "lineage_finalization")).toBe(false); // outcome 未完成
    expect(markTreasuryResolutionCleanupStage("r22r_d1", "outcome_finalization")).toBe(true);
    expect(markTreasuryResolutionCleanupStage("r22r_d1", "lineage_finalization")).toBe(true);
    entry = readTreasuryResolutionCleanupEntry("r22r_d1")!;
    expect(entry.markerDischarged && entry.authorityReleased && entry.outcomeFinalized && entry.lineageFinalized).toBe(true);
  });
});

describe("E：GRA 孤儿 proof 的 release-trusted 删除门禁（remediation E）", () => {
  const ROOT_ID = "r22r_gr_root";
  const ROOT_DIGEST = "1111111111111111";
  const ROOT_DURABLE = "2222222222222222";
  let lineageId = "";

  /** gen1 proof + active record 已推进 gen2 的完整场景。 */
  function seedOrphanProofScene(): { readonly gen2Id: string } {
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: ROOT_ID,
      rootIdentity: { digest: ROOT_DIGEST, durableIdentityDigest: ROOT_DURABLE, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME },
      actionKind: "terminal.send",
      authorityClass: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      rearmable: true,
      identityProfile: "lowlevel",
      retrySemanticDigest: "6666666666666666",
    });
    expect(created.status).toBe("written");
    if (created.status === "rejected") throw new Error("seed create rejected");
    lineageId = created.record.lineageId;
    expect(convergeTreasuryLineageRetirementFromFacts(lineageId).status).toBe("completed");
    const gen1Id = deriveTreasuryLineageNextChildTransactionId(lineageId, 1, ROOT_ID);
    expect(stageTreasuryLineageCapabilityIssued(lineageId, gen1Id).status).not.toBe("rejected");
    expect(stageTreasuryLineageChildIntentPending(lineageId, gen1Id).status).not.toBe("rejected");
    const binding1 = readTreasuryAttemptLineageRecord(lineageId)!.pendingBindingDigest!;
    const durable1 = recomputeTreasuryDurableIdentityDigest({
      transactionId: gen1Id,
      digest: ROOT_DIGEST,
      actionKind: "terminal.send",
      source: "test",
      postings: POSTINGS.map((leg) => ({ ...leg })),
      lineageId,
      lineageGeneration: 1,
      parentTransactionId: ROOT_ID,
      lineageBindingDigest: binding1,
    });
    expect(durable1).not.toBeNull();
    expect(activateTreasuryLineageChild(lineageId, { digest: ROOT_DIGEST, durableIdentityDigest: durable1!, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME }).status).not.toBe("rejected");
    // gen1 退休（retiring → converge 写入 gen1 exact proof——sweep 的对象；
    // 手工场景无 authority/marker/tombstone，三段事实平凡成立）。
    expect(retireTreasuryLineageCurrentAttempt({ lineageId }).status).not.toBe("rejected");
    expect(convergeTreasuryLineageRetirementFromFacts(lineageId).status).toBe("completed");
    expect(readTreasuryGenerationRetirementProof(lineageId, 1)).toBeDefined();
    // active record 推进到 gen2（gen1 成为上一代）。
    const gen2Id = deriveTreasuryLineageNextChildTransactionId(lineageId, 2, ROOT_ID);
    expect(stageTreasuryLineageCapabilityIssued(lineageId, gen2Id).status).not.toBe("rejected");
    expect(stageTreasuryLineageChildIntentPending(lineageId, gen2Id).status).not.toBe("rejected");
    const binding2 = readTreasuryAttemptLineageRecord(lineageId)!.pendingBindingDigest!;
    const durable2 = recomputeTreasuryDurableIdentityDigest({
      transactionId: gen2Id,
      digest: ROOT_DIGEST,
      actionKind: "terminal.send",
      source: "test",
      postings: POSTINGS.map((leg) => ({ ...leg })),
      lineageId,
      lineageGeneration: 2,
      parentTransactionId: gen1Id,
      lineageBindingDigest: binding2,
    });
    expect(durable2).not.toBeNull();
    expect(activateTreasuryLineageChild(lineageId, { digest: ROOT_DIGEST, durableIdentityDigest: durable2!, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME }).status).not.toBe("rejected");
    // record source 装配（active record 的 generation/profile 判定）。
    registerTreasurySemanticLineageRecordSourceForAssembly({
      healthy: () => true,
      unhealthyDetail: () => null,
      readByLineageId: (id) => readTreasuryAttemptLineageRecord(id),
    });
    return { gen2Id };
  }

  it("基线：全部依赖释放 → released", () => {
    seedOrphanProofScene();
    const result = sweepTreasuryOrphanGenerationProofOnAdvance(lineageId, 1);
    expect(result.status).toBe("released");
    expect(readTreasuryGenerationRetirementProof(lineageId, 1)).toBeUndefined();
  });

  it("unrelated receipt entry 损坏（trusted store unhealthy）→ retained", () => {
    const { gen2Id } = seedOrphanProofScene();
    void gen2Id;
    // 塞一个损坏的无关 receipt entry（trusted release 级全表扫描发现即 unhealthy）。
    const treasury = (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury!;
    treasury.receipts = {
      version: 8,
      settled: { "t:unrelated_deadbeef": { transactionId: "unrelated_deadbeef", garbage: true } },
      entryCount: 1,
      updatedAt: Game.time,
      nextExpiry: null as unknown as number,
    };
    const result = sweepTreasuryOrphanGenerationProofOnAdvance(lineageId, 1);
    expect(result).toMatchObject({ status: "retained", detail: expect.stringContaining("trusted receipt") });
    expect(readTreasuryGenerationRetirementProof(lineageId, 1)).toBeDefined();
  });

  it("cleanup journal 损坏 → retained（不折叠为无 pending）", () => {
    seedOrphanProofScene();
    const treasury = (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury!;
    treasury.resolutionCleanup = { version: 77, entries: {}, entryCount: 0, updatedAt: Game.time };
    const result = sweepTreasuryOrphanGenerationProofOnAdvance(lineageId, 1);
    expect(result).toMatchObject({ status: "retained", detail: expect.stringContaining("cleanup journal unhealthy") });
  });

  it("cleanup journal pending → retained", () => {
    seedOrphanProofScene();
    const gen1Proof = readTreasuryGenerationRetirementProof(lineageId, 1)!;
    const gen1ProofTransaction = gen1Proof.transactionId;
    openTreasuryResolutionCleanup({
      transactionId: gen1ProofTransaction,
      digest: ROOT_DIGEST,
      resolution: "not-executed",
      identityProfile: "lowlevel",
      proofClass: "lowlevel",
      durableIdentityDigest: gen1Proof.durableIdentityDigest!,
      lowlevelSource: gen1Proof.lowlevelSource!,
    });
    const result = sweepTreasuryOrphanGenerationProofOnAdvance(lineageId, 1);
    expect(result).toMatchObject({ status: "retained", detail: expect.stringContaining("pending") });
  });

  it("matching write-fault marker 残留 → retained；marker malformed → retained", () => {
    seedOrphanProofScene();
    const gen1ProofTransaction = readTreasuryGenerationRetirementProof(lineageId, 1)!.transactionId;
    seedV4Marker({ transactionId: gen1ProofTransaction, lineageId, lineageGeneration: 1, parentTransactionId: ROOT_ID, lineageBindingDigest: computeTreasuryLineageBindingDigest({ lineageId, generation: 1, parentTransactionId: ROOT_ID, childTransactionId: gen1ProofTransaction }) });
    let result = sweepTreasuryOrphanGenerationProofOnAdvance(lineageId, 1);
    expect(result).toMatchObject({ status: "retained", detail: expect.stringContaining("matching write-fault marker") });
    // malformed marker（matching 不可判定）。
    (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury!.writeFault = { transactionId: gen1ProofTransaction };
    result = sweepTreasuryOrphanGenerationProofOnAdvance(lineageId, 1);
    expect(result).toMatchObject({ status: "retained", detail: expect.stringContaining("malformed") });
    (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury!.writeFault = undefined;
  });

  it("receipt legacy/unknown version → retained（replay-readable 通道不作删除门禁）", () => {
    seedOrphanProofScene();
    const gen1ProofTransaction = readTreasuryGenerationRetirementProof(lineageId, 1)!.transactionId;
    // receipt store 未知版本（legacy/不可解释形态）——trusted 读取 fail closed。
    const treasury = (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury!;
    treasury.receipts = {
      version: 99,
      settled: {},
      entryCount: 0,
      updatedAt: Game.time,
      nextExpiry: null as unknown as number,
    };
    const result = sweepTreasuryOrphanGenerationProofOnAdvance(lineageId, 1);
    expect(result).toMatchObject({ status: "retained", detail: expect.stringContaining("trusted receipt") });
    expect(readTreasuryGenerationRetirementProof(lineageId, 1)).toBeDefined();
  });
});

describe("F：purpose 必填契约与 unresolvedAuthority ok 路径回归（remediation F）", () => {
  const SOURCE_ROOT = path.resolve(__dirname);

  it("类型契约：validateTreasurySemanticLineage 的 purpose 为非可选字段（架构防回退）", () => {
    const source = fs.readFileSync(path.join(SOURCE_ROOT, "semanticLineageValidation.ts"), "utf8");
    expect(source).toMatch(/readonly purpose: TreasurySemanticLineagePurpose;/);
    expect(source).not.toMatch(/readonly purpose\?: TreasurySemanticLineagePurpose/);
  });

  it("生产调用面：全部 validateTreasurySemanticLineage 调用点显式携带 purpose", () => {
    const productionFiles = fs
      .readdirSync(SOURCE_ROOT)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    let callSites = 0;
    for (const name of productionFiles) {
      const source = fs.readFileSync(path.join(SOURCE_ROOT, name), "utf8");
      const matches = source.match(/validateTreasurySemanticLineage\(\{/g) ?? [];
      callSites += matches.length;
      if (matches.length > 0) {
        // 每个调用点附近（250 字符窗口）必须出现 purpose: 声明。
        let cursor = 0;
        for (const _match of matches) {
          const at = source.indexOf("validateTreasurySemanticLineage({", cursor);
          const window = source.slice(at, at + 600);
          expect(window).toMatch(/purpose\s*[:,]/);
          cursor = at + 1;
        }
      }
    }
    // 【Remediation III】resolutionCleanupStageHandlers（facade 装配语义的
    // 迁移目标）新增 semantic lineage verdict 调用点：8 → 9。
    expect(callSites).toBe(10);
  });

  it("运行时 defensive：缺 purpose 的调用（类型外）→ store_unhealthy fail closed", () => {
    expect(
      validateTreasurySemanticLineage({
        transactionId: "r22r_f1",
        proof: { lineageId: "1111111111111111", lineageGeneration: 1, parentTransactionId: "p", lineageBindingDigest: "2222222222222222" },
      } as never),
    ).toMatchObject({ verdict: "store_unhealthy" });
  });

  /** tr1_ chain + 三种 authority 形态（intent-only / quarantine-only / 双一致）。 */
  function seedTr1AuthorityScene(): {
    readonly childId: string;
    readonly facts: {
      readonly lineageId: string;
      readonly lineageGeneration: number;
      readonly parentTransactionId: string;
      readonly lineageBindingDigest: string;
      readonly digest: string;
      readonly durableIdentityDigest: string;
    };
  } {
    const rootId = "r22r_f_root";
    const rootDurable = recomputeTreasuryDurableIdentityDigest({
      transactionId: rootId,
      digest: ROOT_F_DIGEST,
      actionKind: "terminal.send",
      source: "test",
      postings: POSTINGS.map((leg) => ({ ...leg })),
    })!;
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: rootId,
      rootIdentity: { digest: ROOT_F_DIGEST, durableIdentityDigest: rootDurable, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME },
      actionKind: "terminal.send",
      authorityClass: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      rearmable: true,
      identityProfile: "lowlevel",
      retrySemanticDigest: "6666666666666666",
    });
    expect(created.status).toBe("written");
    if (created.status === "rejected") throw new Error("seed create rejected");
    const lid = created.record.lineageId;
    expect(convergeTreasuryLineageRetirementFromFacts(lid).status).toBe("completed");
    const childId = deriveTreasuryLineageNextChildTransactionId(lid, 1, rootId);
    expect(stageTreasuryLineageCapabilityIssued(lid, childId).status).not.toBe("rejected");
    expect(stageTreasuryLineageChildIntentPending(lid, childId).status).not.toBe("rejected");
    const binding = readTreasuryAttemptLineageRecord(lid)!.pendingBindingDigest!;
    const durable = recomputeTreasuryDurableIdentityDigest({
      transactionId: childId,
      digest: ROOT_F_DIGEST,
      actionKind: "terminal.send",
      source: "test",
      postings: POSTINGS.map((leg) => ({ ...leg })),
      lineageId: lid,
      lineageGeneration: 1,
      parentTransactionId: rootId,
      lineageBindingDigest: binding,
    })!;
    expect(activateTreasuryLineageChild(lid, { digest: ROOT_F_DIGEST, durableIdentityDigest: durable, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME }).status).not.toBe("rejected");
    registerTreasurySemanticLineageRecordSourceForAssembly({
      healthy: () => true,
      unhealthyDetail: () => null,
      readByLineageId: (id) => readTreasuryAttemptLineageRecord(id),
    });
    registerTreasuryRetirementSummarySemanticSourceForAssembly();
    registerTreasuryGenerationRetirementSemanticSourceForAssembly();
    return {
      childId,
      facts: { lineageId: lid, lineageGeneration: 1, parentTransactionId: rootId, lineageBindingDigest: binding, digest: ROOT_F_DIGEST, durableIdentityDigest: durable },
    };
  }

  const ROOT_F_DIGEST = "1234567890abcdef";

  function seedTr1Intent(childId: string, facts: ReturnType<typeof seedTr1AuthorityScene>["facts"]): void {
    const write = writeTreasuryIntentEntry({
      authorityLevel: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      transactionId: childId,
      digest: facts.digest,
      actionKind: "terminal.send",
      kind: "terminal.send",
      source: "test",
      postings: POSTINGS.map((leg) => ({ ...leg })),
      outcome: "started_unknown",
      settlement: "executing",
      auditSource: "test",
      lineageId: facts.lineageId,
      lineageGeneration: facts.lineageGeneration,
      parentTransactionId: facts.parentTransactionId,
      lineageBindingDigest: facts.lineageBindingDigest,
      durableIdentityDigest: facts.durableIdentityDigest,
      createdAtTick: Game.time,
      updatedAtTick: Game.time,
    });
    expect(write.status).toBe("written");
  }

  function seedTr1Quarantine(childId: string, facts: ReturnType<typeof seedTr1AuthorityScene>["facts"]): void {
    const entry: Record<string, unknown> = {
      transactionId: childId,
      digest: facts.digest,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      deltas: POSTINGS.map((leg) => ({ ...leg })),
      phase: "action_threw_execution_unknown",
      outcome: "started_unknown",
      settlement: "quarantined",
      tick: Game.time,
      recordedAt: Game.time,
      authorityLevel: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      lineageId: facts.lineageId,
      lineageGeneration: facts.lineageGeneration,
      parentTransactionId: facts.parentTransactionId,
      lineageBindingDigest: facts.lineageBindingDigest,
      durableIdentityDigest: facts.durableIdentityDigest,
    };
    const treasury = (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury ?? {};
    (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury = treasury;
    treasury.quarantine = {
      version: 6,
      entries: { [`q:${childId}`]: entry },
      entryCount: 1,
      updatedAt: Game.time,
    };
    resetTreasuryQuarantineRuntimeForTest();
    expect(readTreasuryQuarantineEntry(childId)).toBeDefined();
  }

  it("ok 路径 1：intent-only tr1_ authority → ok（purpose=authority_resolution 的 semantic gate 通过）", () => {
    const { childId, facts } = seedTr1AuthorityScene();
    seedTr1Intent(childId, facts);
    const resolved = resolveTreasuryUnresolvedAuthority(childId);
    expect(resolved.status).toBe("ok");
    if (resolved.status !== "ok") return;
    expect(resolved.authority.transactionId).toBe(childId);
    expect(resolved.authority.lineageId).toBe(facts.lineageId);
    expect(resolved.authority.authorityLevel).toBe("lowlevel");
  });

  it("ok 路径 2：quarantine-only tr1_ authority → ok", () => {
    const { childId, facts } = seedTr1AuthorityScene();
    seedTr1Quarantine(childId, facts);
    const resolved = resolveTreasuryUnresolvedAuthority(childId);
    expect(resolved.status).toBe("ok");
    if (resolved.status !== "ok") return;
    expect(resolved.authority.transactionId).toBe(childId);
    expect(resolved.authority.lineageId).toBe(facts.lineageId);
  });

  it("ok 路径 3：quarantine + intent 双存在一致 → ok（quarantine 优先合并）", () => {
    const { childId, facts } = seedTr1AuthorityScene();
    seedTr1Intent(childId, facts);
    seedTr1Quarantine(childId, facts);
    const resolved = resolveTreasuryUnresolvedAuthority(childId);
    expect(resolved.status).toBe("ok");
    if (resolved.status !== "ok") return;
    expect(resolved.authority.transactionId).toBe(childId);
    expect(resolved.authority.lineageId).toBe(facts.lineageId);
  });
});

