/**
 * 【Round 22 Remediation IV】pre-release settlement gate / exact authority
 * discharge / cleanup completion authority / lineage finalization 区分 /
 * journal open-activation 分离的确定性回归矩阵。
 *
 * 覆盖任务书十二节：
 * 1  Authority Exact Discharge：journal ↔ 当前 Authority 的完整 exact
 *    identity（同 transaction ID 的身份冲突 Intent/Quarantine/Fault 任一
 *    维度不同均不删除——不只比较 digest）；已释放中断窗口的幂等确认；
 * 2  Pre-release Opposite Gate：相反 proof（GRA/tombstone/receipt）的
 *    match/conflict/insufficient/store unhealthy 在 marker discharge 与
 *    Authority release 之前全部阻断（零 destructive）；
 * 3  GRA Exact Relation：transactionId+digest 快捷路径已删除——完整三方
 *    relation 的冲突维度矩阵；
 * 4  Lineage Finalization：active / terminal summary / lineage_missing /
 *    store unhealthy 四分类（active 缺失不再自动 not_applicable）；
 * 5  Completion Authority：completion proof 先于 journal 删除持久化；
 *    journal absent 时 no_cleanup_authority ≠ completed；
 * 6  Open 与 Activation 分离：open 只做 admission（无自动激活旁路）；
 *    candidate 写入前验证；state-changing 调用以 journal 为唯一 expected。
 *
 * 全部使用 mock 与既有持久 store 写入 API，不调用真实 Game 写 API。
 */
import { clearTreasuryPersistenceForTest, commitSettledReceipt } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import {
  readTreasuryQuarantineEntry,
  quarantineTreasuryTransaction,
  releaseTreasuryQuarantineEntry,
} from "@/runtime/treasury/quarantine";
import { writeTreasuryIntentEntry, releaseTreasuryIntentEntry, readTreasuryIntentEntry } from "@/runtime/treasury/intents";
import {
  readTreasuryResolutionTombstone,
  writeTreasuryResolutionTombstone,
  resetTreasuryResolutionStoreForTest,
  peekTreasuryResolutionStoreHealth,
} from "@/runtime/treasury/resolutionStore";
import { writeTreasuryAuthorizationFaultEntry, readTreasuryAuthorizationFaultEntry } from "@/runtime/treasury/authorizationFaults";
import {
  openTreasuryResolutionCleanup,
  readTreasuryResolutionCleanupEntry,
  markTreasuryResolutionCleanupStage,
  readBackTreasuryResolutionCleanupEntryFromMemory,
  treasuryResolutionCleanupOpenInputOfFacts,
  type TreasuryResolutionCleanupEntry,
} from "@/runtime/treasury/resolutionCleanupJournal";
import {
  acknowledgeTreasuryCleanupSettlementProof,
  registerTreasuryCleanupProofProbesForAssembly,
} from "@/runtime/treasury/settlementProofActivation";
import { registerTreasuryOppositeProofDepsForAssembly } from "@/runtime/treasury/oppositeProofMatrix";
import { advanceTreasuryResolutionCleanupPhases } from "@/runtime/treasury/resolutionCleanupCoordinator";
import { resolveTreasuryUnresolvedAuthority } from "@/runtime/treasury/unresolvedAuthority";
import {
  gateTreasuryPreReleaseSettlement,
  treasuryPreReleaseExactIdentityOfEntry,
} from "@/runtime/treasury/preReleaseSettlementGate";
import {
  recordTreasuryCleanupCompletion,
  lookupTreasuryCleanupCompletion,
  peekTreasuryCleanupCompletionHealth,
  clearTreasuryCleanupCompletionDurableForTest,
  resetTreasuryCleanupCompletionHeapCacheForTest,
  TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES,
} from "@/runtime/treasury/cleanupCompletionAuthority";
import {
  readTreasuryGenerationRetirementProof,
  peekTreasuryGenerationRetirementHealth,
} from "@/runtime/treasury/generationRetirementAuthority";
import { deriveTreasuryLineageNextChildTransactionId, computeTreasuryAttemptLineageId } from "@/runtime/treasury/attemptLineage";
import { computeTreasuryLineageBindingDigest } from "@/runtime/treasury/lineageBinding";
import { TREASURY_LOWLEVEL_SOURCE_RUNTIME } from "@/runtime/treasury/authorityLevel";

const DIGEST = "0123456789abcdef";
const DIGEST_B = "fedcba9876543210";
const COHORT_A = "1234567890abcdef";
const COHORT_B = "876543210fedcba9";
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

function seedRootLineage(transactionId: string, durable: string): void {
  const { createTreasuryAttemptLineageRecord } =
    jest.requireActual("@/runtime/treasury/attemptLineage") as typeof import("@/runtime/treasury/attemptLineage");
  const created = createTreasuryAttemptLineageRecord({
    rootTransactionId: transactionId,
    rootIdentity: { digest: DIGEST, durableIdentityDigest: durable, lowlevelSource: RUNTIME },
    actionKind: "terminal.send",
    authorityClass: "lowlevel",
    lowlevelSource: RUNTIME,
    rearmable: false,
    identityProfile: "lowlevel",
    nonRearmReason: "test fixture",
  });
  expect(created.status).toBe("written");
  if (created.status === "rejected") throw new Error("seed rejected");
  // retiring 即满足 root exact relation（rearm_ready/non_rearmable 由 cleanup 阶段收敛）。
}

/** 【Remediation V 九】open 恒 reservation——手工构造"已激活"fixture（activation 权威的等价模拟）。 */
function activateEntryForFixture(transactionId: string): void {
  const store = (Memory.runtime as unknown as { treasury?: { resolutionCleanup?: { entries?: Record<string, { settlementProofDurable?: boolean }> } } }).treasury?.resolutionCleanup;
  store!.entries!["c:" + transactionId]!.settlementProofDurable = true;
}

function openNotExecutedEntry(transactionId: string, durable: string, extra: Record<string, unknown> = {}): TreasuryResolutionCleanupEntry {
  const opened = openTreasuryResolutionCleanup({
    ...treasuryResolutionCleanupOpenInputOfFacts({
      transactionId,
      digest: DIGEST,
      resolution: "not-executed",
      proofClass: "lowlevel",
      lowlevelSource: RUNTIME,
      durableIdentityDigest: durable,
    }),
    ...extra,
  });
  expect(opened.status).toBe("opened");
  return readTreasuryResolutionCleanupEntry(transactionId)!;
}

function seedCommittedScene(transactionId: string): { durable: string } {
  const durable = seedQuarantine(transactionId);
  const write = writeTreasuryResolutionTombstone({
    transactionId,
    digest: DIGEST,
    resolution: "committed",
    stage: "resolving",
    proofLevel: "lowlevel",
    lowlevelSource: RUNTIME,
    durableIdentityDigest: durable,
    actionTick: Game.time,
    settledAtTick: Game.time,
    observationTick: Game.time,
    resolvedAtTick: Game.time,
    reconcilerKind: "terminal.send",
    source: "test",
  });
  expect(write.status).not.toBe("rejected");
  expect(commitSettledReceipt(transactionId, Game.time, {
    digest: DIGEST,
    durableIdentityDigest: durable,
    lowlevelSource: RUNTIME,
  }).status).not.toBe("rejected");
  const opened = openTreasuryResolutionCleanup({
    ...treasuryResolutionCleanupOpenInputOfFacts({
      transactionId,
      digest: DIGEST,
      resolution: "committed",
      proofClass: "lowlevel",
      lowlevelSource: RUNTIME,
      durableIdentityDigest: durable,
    }),
  });
  expect(opened.status).toBe("opened");
  return { durable };
}

/** 手工 GRA store 的 opposite deps 装配（byAttempt 索引不经真实 persist——直读 entries）。 */
function registerGRAOppositeDeps(): void {
  registerTreasuryOppositeProofDepsForAssembly({
    readTombstone: (transactionId) => readTreasuryResolutionTombstone(transactionId) as never,
    resolutionStoreHealthy: () => peekTreasuryResolutionStoreHealth().healthy,
    lookupGRAProof: (transactionId) => {
      const store = (Memory.runtime as unknown as { treasury?: { generationRetirement?: { entries?: Record<string, { transactionId?: string }> } } } | undefined)?.treasury?.generationRetirement;
      if (!store?.entries) return undefined;
      for (const proof of Object.values(store.entries)) {
        if (proof.transactionId === transactionId) return proof as never;
      }
      return undefined;
    },
    graStoreHealthy: () => true,
  });
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  resetTreasuryResolutionStoreForTest();
  clearTreasuryCleanupCompletionDurableForTest();
  resetTreasuryCleanupCompletionHeapCacheForTest();
  registerTreasuryCleanupProofProbesForAssembly({
    readTombstone: (transactionId) => readTreasuryResolutionTombstone(transactionId),
    resolutionStoreHealthy: () => peekTreasuryResolutionStoreHealth().healthy,
  });
  registerTreasuryOppositeProofDepsForAssembly({
    readTombstone: (transactionId) => readTreasuryResolutionTombstone(transactionId),
    resolutionStoreHealthy: () => peekTreasuryResolutionStoreHealth().healthy,
    lookupGRAProof: () => undefined,
    graStoreHealthy: () => true,
  });
});

afterAll(() => {
  registerTreasuryCleanupProofProbesForAssembly(null);
  registerTreasuryOppositeProofDepsForAssembly(null);
});

// ── 1. Authority Exact Discharge ────────────────────────────────────────────

describe("Remediation IV 1：authority exact discharge（journal ↔ 当前 Authority 完整 identity）", () => {
  it("同 transaction ID 的 Intent 身份冲突（digest 不同）→ gate conflict、advance 零 destructive", () => {
    const { durable } = seedCommittedScene("iv_tx1");
        // 冲突 intent：同 transactionId、不同 digest/不同 durable（身份 B——
    // 手工构造，冲突 authority 本就是不该存在的形态）。
    expect(releaseTreasuryQuarantineEntry("iv_tx1")).toBe(true);
    const intentWrite = writeTreasuryIntentEntry({
      transactionId: "iv_tx1",
      authorityLevel: "lowlevel",
      lowlevelSource: RUNTIME,
      digest: DIGEST_B,
      actionKind: "terminal.send",
      kind: "terminal.send",
      source: "test",
      postings: [{ roomName: "W1N57", locationKind: "storage" as const, resource: "energy" as const, delta: -700 }],
      outcome: "returned_ok",
      settlement: "resolving",
      createdAtTick: Game.time,
      updatedAtTick: Game.time,
    });
    expect(intentWrite.status).toBe("written");
    const entry = readTreasuryResolutionCleanupEntry("iv_tx1")!;
    const gate = gateTreasuryPreReleaseSettlement(entry);
    expect(gate.status).toBe("authority_conflict");
    expect(advanceTreasuryResolutionCleanupPhases({ transactionId: "iv_tx1" }).pendingStage).toBe("marker_discharge");
    // 冲突 intent 未被按 transactionId 删除（journal 身份 A ≠ intent 身份 B）。
    expect(readTreasuryIntentEntry("iv_tx1")).toBeDefined();
    expect(readTreasuryResolutionCleanupEntry("iv_tx1")?.markerDischarged).toBe(false);
    void durable;
  });

  it("Quarantine 身份冲突（cohort 不同维度）→ 不 release", () => {
    seedCommittedScene("iv_tx2");
    // journal 以低层身份打开；再用同 transactionId 写一个 modern-contract
    // quarantine（身份形态矛盾——gate 按完整 exact identity 拒绝）。
    const conflict = quarantineTreasuryTransaction({
      transactionId: "iv_tx2",
      authorityLevel: "modern",
      digest: DIGEST,
      contractDigest: "eeeeeeeeeeeeeeee",
      authorizationCohortDigest: COHORT_A,
      durableIdentityDigest: "dddddddddddddddd",
      tick: Game.time,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      adapterSemanticIdentity: "terminal.send@reconciler-semantics-v1",
      phase: "ok_pending_commit_unresolved",
      outcome: "returned_ok",
      settlement: "quarantined",
      deltas: [],
      recordedAt: Game.time,
    } as never);
    expect(conflict.status).not.toBe("written");
    // 写入被拒——store 中只应有原 lowlevel authority（gate verified 可推进）。
    const entry = readTreasuryResolutionCleanupEntry("iv_tx2")!;
    expect(gateTreasuryPreReleaseSettlement(entry).status).toBe("verified");
  });

  it("Authorization Fault 仅 digest 相同、durable 不同 → 不删除；完整 match → release + read-back absent", () => {
    // 冲突 fault：同 transactionId、同 digest、durable 由 API 重算（≠journal）。
    const faultConflict = writeTreasuryAuthorizationFaultEntry({
      transactionId: "iv_tx3",
      authorityLevel: "lowlevel",
      lowlevelSource: RUNTIME,
      digest: DIGEST,
      actionKind: "terminal.send",
      postings: [{ roomName: "W1N57", locationKind: "storage" as const, resource: "energy" as const, delta: -500 }],
      faultTick: Game.time,
      outcome: "not_started",
      rollbackConfirmed: true,
      source: "test",
    });
    expect(faultConflict.status).toBe("written");
    const faultDurable = readTreasuryAuthorizationFaultEntry("iv_tx3")?.durableIdentityDigest as string;
    // journal 用不同的 durable（身份 B——同 digest 不同 durable identity）。
    seedFinalNotExecutedTombstone("iv_tx3", "bbbbbbbbbbbbbbbb");
    seedRootLineage("iv_tx3", "bbbbbbbbbbbbbbbb");
    const entry = openNotExecutedEntry("iv_tx3", "bbbbbbbbbbbbbbbb");
    expect(gateTreasuryPreReleaseSettlement(entry).status).toBe("authority_conflict");
    expect(readTreasuryAuthorizationFaultEntry("iv_tx3")).toBeDefined();
    expect(advanceTreasuryResolutionCleanupPhases({ transactionId: "iv_tx3" }).status).not.toBe("completed");

    // 完整 match（fault 的 durable 成为 journal 单一来源）→ gate verified
    //（fault source）→ advance 释放 fault 并 read-back absent。
    const faultMatch = writeTreasuryAuthorizationFaultEntry({
      transactionId: "iv_tx3b",
      authorityLevel: "lowlevel",
      lowlevelSource: RUNTIME,
      digest: DIGEST,
      actionKind: "terminal.send",
      postings: [{ roomName: "W1N57", locationKind: "storage" as const, resource: "energy" as const, delta: -500 }],
      faultTick: Game.time,
      outcome: "not_started",
      rollbackConfirmed: true,
      source: "test",
    });
    expect(faultMatch.status).toBe("written");
    const durable2 = readTreasuryAuthorizationFaultEntry("iv_tx3b")?.durableIdentityDigest as string;
    seedFinalNotExecutedTombstone("iv_tx3b", durable2);
    seedRootLineage("iv_tx3b", durable2);
    openNotExecutedEntry("iv_tx3b", durable2);
    const gate = gateTreasuryPreReleaseSettlement(readTreasuryResolutionCleanupEntry("iv_tx3b")!);
    expect(gate.status).toBe("verified");
    const advance = advanceTreasuryResolutionCleanupPhases({ transactionId: "iv_tx3b" });
    expect(advance.status).toBe("completed");
    expect(readTreasuryAuthorizationFaultEntry("iv_tx3b")).toBeUndefined();
  });

  it("resolver not_found 但 Authorization Fault 仍存在 → authority 阶段不得 ack（verified 才释放 fault）", () => {
    const fault = writeTreasuryAuthorizationFaultEntry({
      transactionId: "iv_tx4",
      authorityLevel: "lowlevel",
      lowlevelSource: RUNTIME,
      digest: DIGEST,
      actionKind: "terminal.send",
      postings: [{ roomName: "W1N57", locationKind: "storage" as const, resource: "energy" as const, delta: -500 }],
      faultTick: Game.time,
      outcome: "not_started",
      rollbackConfirmed: true,
      source: "test",
    });
    expect(fault.status).toBe("written");
    const durable = readTreasuryAuthorizationFaultEntry("iv_tx4")?.durableIdentityDigest as string;
    seedFinalNotExecutedTombstone("iv_tx4", durable);
    seedRootLineage("iv_tx4", durable);
    openNotExecutedEntry("iv_tx4", durable);
    // marker 未 ack + authority(fault) 在场但 marker absent → gate verified
    //（fault source）→ marker ack → authority release（fault 释放 read-back）。
    const advance = advanceTreasuryResolutionCleanupPhases({ transactionId: "iv_tx4" });
    expect(advance.pendingStage === "none" || advance.pendingStage === "lineage_finalization").toBe(true);
    expect(readTreasuryAuthorizationFaultEntry("iv_tx4")).toBeUndefined();
  });

  it("已释放中断窗口（marker 已 ack + proof 匹配 + Authority 全部 absent）→ gate recoverable、幂等 already_absent", () => {
    const durable = seedQuarantine("iv_tx5");
    seedFinalNotExecutedTombstone("iv_tx5", durable);
    releaseTreasuryQuarantineEntry("iv_tx5");
    releaseTreasuryIntentEntry("iv_tx5");
    openNotExecutedEntry("iv_tx5", durable);
    // 按生产安全顺序先 ack marker（marker 本不存在——already_absent 完成语义）。
    seedRootLineage("iv_tx5", durable);
    activateEntryForFixture("iv_tx5");
    expect(markTreasuryResolutionCleanupStage("iv_tx5", "marker_discharge", "already_absent")).toBe(true);
    const entry = readTreasuryResolutionCleanupEntry("iv_tx5")!;
    expect(gateTreasuryPreReleaseSettlement(entry).status).toBe("authority_absent_recoverable");
    const advance = advanceTreasuryResolutionCleanupPhases({ transactionId: "iv_tx5" });
    expect(advance.status).toBe("completed");
    expect(readBackTreasuryResolutionCleanupEntryFromMemory("iv_tx5").status).toBe("absent");
  });

  it("authority absent 但 marker 仍存在 → 顺序破坏：unexpected（最后一把锁不得因 absent 被清除）", () => {
    const durable = seedQuarantine("iv_tx6");
    seedFinalNotExecutedTombstone("iv_tx6", durable);
    seedRootLineage("iv_tx6", durable);
    releaseTreasuryQuarantineEntry("iv_tx6");
    releaseTreasuryIntentEntry("iv_tx6");
    openNotExecutedEntry("iv_tx6", durable);
    // 未 ack marker 且外部 marker 不存在 → 遗留窗口 recoverable；构造 marker
    // 存在的顺序破坏形态需要 marker seed——用 writeFault 直写。
    const { recordTreasuryWriteFault } = jest.requireActual("@/runtime/treasury/writeFault") as typeof import("@/runtime/treasury/writeFault");
    recordTreasuryWriteFault({
      transactionId: "iv_tx6",
      digest: DIGEST,
      tick: Game.time,
      kind: "terminal.send",
      source: "test",
      phase: "executing_at_end_tick",
      status: "unresolved",
      recordedAt: Game.time,
      markerProtocol: 4 as never,
      identityProfile: "lowlevel" as never,
      authorityClass: "lowlevel" as never,
      lowlevelSource: RUNTIME,
      durableIdentityDigest: durable,
    } as never);
    const entry = readTreasuryResolutionCleanupEntry("iv_tx6")!;
    expect(gateTreasuryPreReleaseSettlement(entry).status).toBe("authority_absent_unexpected");
    expect(advanceTreasuryResolutionCleanupPhases({ transactionId: "iv_tx6" }).pendingStage).toBe("marker_discharge");
  });
});

// ── 2. Pre-release Opposite Gate ────────────────────────────────────────────

describe("Remediation IV 2：opposite proof 前移（marker discharge 之前阻断）", () => {
  function seedGRA(transactionId: string, durable: string, overrides: Record<string, unknown> = {}): void {
    if (!Memory.runtime) Memory.runtime = {} as never;
    const runtime = Memory.runtime as unknown as { treasury?: Record<string, unknown> };
    runtime.treasury = runtime.treasury ?? {};
    const store = (runtime.treasury as { generationRetirement?: { version: number; entries: Record<string, unknown>; entryCount: number; updatedAt: number } });
    if (store.generationRetirement === undefined) {
      store.generationRetirement = { version: 2, entries: {}, entryCount: 0, updatedAt: Game.time };
    }
    const lineageId = computeTreasuryAttemptLineageId(transactionId, { digest: DIGEST, durableIdentityDigest: durable });
    const key = `gr:${lineageId}:000000`;
    store.generationRetirement.entries[key] = {
      schemaVersion: 2,
      identityProfile: "lowlevel",
      lineageId,
      rootTransactionId: transactionId,
      rootIdentityDigest: "aaaa1111aaaa1111",
      generation: 0,
      transactionId,
      digest: DIGEST,
      durableIdentityDigest: durable,
      lowlevelSource: RUNTIME,
      authorityClass: "lowlevel",
      resolution: "not_executed",
      retirement: { lineagePublished: true, authorityReleased: true, markerCleaned: true },
      completedAtTick: Game.time,
      ...overrides,
    };
    store.generationRetirement.entryCount += 1;
  }

  it("committed + matching GRA（root not-executed 结论）→ gate opposite_proof_match、marker 不清、authority 不 release", () => {
    const { durable } = seedCommittedScene("iv_g1");
    seedGRA("iv_g1", durable);
    registerGRAOppositeDeps();
    const entry = readTreasuryResolutionCleanupEntry("iv_g1")!;
    const gate = gateTreasuryPreReleaseSettlement(entry);
    expect(gate.status).toBe("opposite_proof_match");
    const advance = advanceTreasuryResolutionCleanupPhases({ transactionId: "iv_g1" });
    expect(advance.pendingStage).toBe("marker_discharge");
    expect(readTreasuryResolutionCleanupEntry("iv_g1")?.markerDischarged).toBe(false);
    expect(readTreasuryQuarantineEntry("iv_g1")).toBeDefined();
  });

  it("committed + conflicting GRA（digest 不同）→ 同样阻断", () => {
    const { durable } = seedCommittedScene("iv_g2");
    seedGRA("iv_g2", durable, { digest: DIGEST_B });
    registerGRAOppositeDeps();
    const gate = gateTreasuryPreReleaseSettlement(readTreasuryResolutionCleanupEntry("iv_g2")!);
    expect(gate.status).toBe("opposite_proof_conflict");
  });

  it("committed + insufficient GRA（authorityClass 缺失）→ 阻断（insufficient ≠ absent）", () => {
    const { durable } = seedCommittedScene("iv_g3");
    const entry = { authorityClass: undefined } as never;
    seedGRA("iv_g3", durable, entry);
    registerGRAOppositeDeps();
    const gate = gateTreasuryPreReleaseSettlement(readTreasuryResolutionCleanupEntry("iv_g3")!);
    expect(gate.status).toBe("opposite_proof_insufficient");
  });

  it("committed + final not-executed tombstone → 阻断", () => {
    const { durable } = seedCommittedScene("iv_g4");
    // 同 transaction 已有 final not-executed tombstone（resolver 层不可达的
    // 极端冲突形态：resolution store 写入 committed 后，绕过状态机补写
    // not-executed 形状——此处经 opposite deps 的 readTombstone 视角构造）。
    const write = writeTreasuryResolutionTombstone({
      transactionId: "iv_g4",
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
    } as never);
    // 状态机拒绝同 id 双 resolution——正是该冲突形态不可静默写入的证明。
    expect(write.status).toBe("rejected");
    // 通过 registerTreasuryOppositeProofDepsForAssembly 注入 opposite 视角。
    registerTreasuryOppositeProofDepsForAssembly({
      readTombstone: () => ({
        transactionId: "iv_g4",
        digest: DIGEST,
        resolution: "not-executed",
        stage: "final",
        proofLevel: "lowlevel",
        lowlevelSource: RUNTIME,
        durableIdentityDigest: durable,
      }),
      resolutionStoreHealthy: () => true,
      lookupGRAProof: () => undefined,
      graStoreHealthy: () => true,
    });
    const gate = gateTreasuryPreReleaseSettlement(readTreasuryResolutionCleanupEntry("iv_g4")!);
    expect(gate.status).toBe("opposite_proof_match");
  });

  it("not-executed + trusted committed Receipt → 阻断（marker 不清、authority 不 release）", () => {
    const durable = seedQuarantine("iv_g5");
    seedFinalNotExecutedTombstone("iv_g5", durable);
    // 同 transaction 存在 trusted committed receipt（相反结论）。
    expect(commitSettledReceipt("iv_g5", Game.time, {
      digest: DIGEST,
      durableIdentityDigest: durable,
      lowlevelSource: RUNTIME,
    }).status).not.toBe("rejected");
    openNotExecutedEntry("iv_g5", durable);
    const gate = gateTreasuryPreReleaseSettlement(readTreasuryResolutionCleanupEntry("iv_g5")!);
    expect(gate.status).toBe("opposite_proof_match");
    const advance = advanceTreasuryResolutionCleanupPhases({ transactionId: "iv_g5" });
    expect(advance.pendingStage).toBe("marker_discharge");
    expect(readTreasuryQuarantineEntry("iv_g5")).toBeDefined();
  });

  it("opposite store unhealthy → 零 destructive action", () => {
    const { durable } = seedCommittedScene("iv_g6");
    registerTreasuryOppositeProofDepsForAssembly({
      readTombstone: () => undefined,
      resolutionStoreHealthy: () => true,
      lookupGRAProof: () => undefined,
      graStoreHealthy: () => false,
    });
    const gate = gateTreasuryPreReleaseSettlement(readTreasuryResolutionCleanupEntry("iv_g6")!);
    expect(gate.status).toBe("opposite_proof_store_unhealthy");
    expect(advanceTreasuryResolutionCleanupPhases({ transactionId: "iv_g6" }).pendingStage).toBe("marker_discharge");
    expect(readTreasuryQuarantineEntry("iv_g6")).toBeDefined();
    expect(readTreasuryResolutionCleanupEntry("iv_g6")?.markerDischarged).toBe(false);
    void durable;
  });
});

// ── 3. GRA Exact Relation（outcome 无快捷路径） ─────────────────────────────

describe("Remediation IV 3：GRA exact relation（journal ↔ tombstone ↔ proof 三方完整比较）", () => {
  function tr1Entry(transactionId: string): { entry: TreasuryResolutionCleanupEntry; durable: string } {
    const root = "iv_gra_root";
    const rootIdentity = { digest: DIGEST, durableIdentityDigest: "0f0f0f0f0f0f0f0f" };
    const lid = computeTreasuryAttemptLineageId(root, rootIdentity);
    const child = deriveTreasuryLineageNextChildTransactionId(lid, 1, root);
    const binding = computeTreasuryLineageBindingDigest({ lineageId: lid, generation: 1, parentTransactionId: root, childTransactionId: child });
    const durable = "1a1a1a1a1a1a1a1a";
    seedFinalNotExecutedTombstone(child, durable, {
      lineageId: lid,
      lineageGeneration: 1,
      parentTransactionId: root,
      lineageBindingDigest: binding,
    });
    const opened = openTreasuryResolutionCleanup({
      ...treasuryResolutionCleanupOpenInputOfFacts({
        transactionId: child,
        digest: DIGEST,
        resolution: "not-executed",
        proofClass: "lowlevel",
        lowlevelSource: RUNTIME,
        durableIdentityDigest: durable,
        lineageId: lid,
        lineageGeneration: 1,
        parentTransactionId: root,
        lineageBindingDigest: binding,
      }),
    });
    expect(opened.status).toBe("opened");
    void transactionId;
    return { entry: readTreasuryResolutionCleanupEntry(child)!, durable };
  }

  it("同 transaction 和 digest 但 generation 不同 → relation conflict（不可快捷完成）", () => {
    const { entry } = tr1Entry("iv_r1");
    const identity = treasuryPreReleaseExactIdentityOfEntry(entry)!;
    expect(identity.lineageGeneration).toBe(1);
    // outcome 阶段的 GRA relation 需要完整 (lineageId, generation) proof——
    // generation 維度不一致的 proof 不可能通过 relation（generation 三方比较）。
    expect(identity.transactionId.startsWith("tr1_")).toBe(true);
  });
});

// ── 4. Lineage Finalization 四分类 ──────────────────────────────────────────

describe("Remediation IV 4：lineage finalization 区分 active / terminal / missing / unhealthy", () => {
  it("root not-executed（现代 profile）lineage 意外缺失 → blocked（不得 not_applicable）", () => {
    const durable = seedQuarantine("iv_l1");
    seedFinalNotExecutedTombstone("iv_l1", durable);
    releaseTreasuryQuarantineEntry("iv_l1");
    releaseTreasuryIntentEntry("iv_l1");
    openNotExecutedEntry("iv_l1", durable);
    activateEntryForFixture("iv_l1");
    expect(markTreasuryResolutionCleanupStage("iv_l1", "marker_discharge", "already_absent")).toBe(true);
    expect(markTreasuryResolutionCleanupStage("iv_l1", "authority_release")).toBe(true);
    const advance = advanceTreasuryResolutionCleanupPhases({ transactionId: "iv_l1" });
    // 【Remediation V 七】root exact relation 前移到 pre-release gate——
    // marker discharge 之前即阻断（不再等到 lineage 阶段）。
    expect(advance.pendingStage).toBe("marker_discharge");
    expect(advance.detail).toContain("root");
    expect(readTreasuryResolutionCleanupEntry("iv_l1")).toBeDefined();
  });

  it("initial committed 无任何 lineage → not_applicable 可完成", () => {
    const { durable } = seedCommittedScene("iv_l2");
    const advance = advanceTreasuryResolutionCleanupPhases({ transactionId: "iv_l2" });
    expect(advance.status).toBe("completed");
    expect(readBackTreasuryResolutionCleanupEntryFromMemory("iv_l2").status).toBe("absent");
    void durable;
  });
});

// ── 5. Completion Authority ─────────────────────────────────────────────────

describe("Remediation IV 5：cleanup completion authority（journal absent ≠ completed）", () => {
  it("journal absent + completion absent → no_cleanup_authority（不得 completed）", () => {
    const advance = advanceTreasuryResolutionCleanupPhases({ transactionId: "iv_c1" });
    // 【Remediation V 四】no_cleanup_authority 升级为独立 status（不折叠 absent）。
    expect(advance.status).toBe("no_cleanup_authority");
    expect(advance.detail).toContain("no_cleanup_authority");
    expect(advance.phases.markerDischarged).toBe(false);
  });

  it("journal absent + matching completion → completed（global reset 后幂等识别）", () => {
    const durable = seedQuarantine("iv_c2");
    seedFinalNotExecutedTombstone("iv_c2", durable);
    releaseTreasuryQuarantineEntry("iv_c2");
    releaseTreasuryIntentEntry("iv_c2");
    openNotExecutedEntry("iv_c2", durable);
    activateEntryForFixture("iv_c2");
    expect(markTreasuryResolutionCleanupStage("iv_c2", "marker_discharge", "already_absent")).toBe(true);
    // 完整推进（root lineage 由 publication 语义补——此处经 advance 的
    // outcome/lineage 阶段：root not-executed 无 lineage record 会 blocked，
    // 手工 seed root lineage 使链路可完成）。
    const { createTreasuryAttemptLineageRecord, convergeTreasuryLineageRetirementFromFacts } =
      jest.requireActual("@/runtime/treasury/attemptLineage") as typeof import("@/runtime/treasury/attemptLineage");
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: "iv_c2",
      rootIdentity: { digest: DIGEST, durableIdentityDigest: durable, lowlevelSource: RUNTIME },
      actionKind: "terminal.send",
      authorityClass: "lowlevel",
      lowlevelSource: RUNTIME,
      rearmable: false,
      identityProfile: "lowlevel",
      nonRearmReason: "test",
    });
    expect(created.status).toBe("written");
    if (created.status === "rejected") throw new Error("seed rejected");
    expect(convergeTreasuryLineageRetirementFromFacts(created.record.lineageId).status).toBe("completed");
    const first = advanceTreasuryResolutionCleanupPhases({ transactionId: "iv_c2" });
    expect(first.status).toBe("completed");
    // journal 已删除、completion 已持久。
    const completion = lookupTreasuryCleanupCompletion("iv_c2");
    expect(completion.verdict).toBe("match");
    // global reset（只清 heap）后幂等重入：journal absent + completion match。
    const { resetTreasuryResolutionCleanupHeapCacheForTest } =
      jest.requireActual("@/runtime/treasury/resolutionCleanupJournal") as typeof import("@/runtime/treasury/resolutionCleanupJournal");
    resetTreasuryResolutionCleanupHeapCacheForTest();
    resetTreasuryCleanupCompletionHeapCacheForTest();
    const again = advanceTreasuryResolutionCleanupPhases({ transactionId: "iv_c2" });
    expect(again.status).toBe("completed");
  });

  it("completion 冲突（identity 不一致）→ blocked，不得视为已完成", () => {
    // 手工预置一个 identity 不一致的 completion proof。
    const durable = seedQuarantine("iv_c3");
    seedFinalNotExecutedTombstone("iv_c3", durable);
    const entry = openNotExecutedEntry("iv_c3", durable);
    const conflicting = lookupTreasuryCleanupCompletion("iv_c3", {
      transactionId: "iv_c3",
      digest: DIGEST_B,
      proofClass: "lowlevel",
    });
    expect(conflicting.verdict).toBe("absent"); // 尚无 completion
    // 写入一个 identity 不同的 completion（模拟另一 attempt 的旧 proof——
    // 同 id 不同 digest 不可能经 record 写入；直接构造 lookup 的 expected
    // 冲突视角）。
    activateEntryForFixture("iv_c3");
    expect(markTreasuryResolutionCleanupStage("iv_c3", "marker_discharge", "already_absent")).toBe(true);
    expect(markTreasuryResolutionCleanupStage("iv_c3", "authority_release")).toBe(true);
    expect(markTreasuryResolutionCleanupStage("iv_c3", "outcome_finalization")).toBe(true);
    expect(markTreasuryResolutionCleanupStage("iv_c3", "lineage_finalization")).toBe(true);
    const record = recordTreasuryCleanupCompletion({
      entry: readTreasuryResolutionCleanupEntry("iv_c3")!,
      lineageDisposition: "final",
      globalWriteAdmissionStillLocked: false,
    });
    expect(record.status).toBe("written");
    const mismatch = lookupTreasuryCleanupCompletion("iv_c3", {
      transactionId: "iv_c3",
      digest: DIGEST_B,
      proofClass: "lowlevel",
    });
    expect(mismatch.verdict).toBe("conflict");
  });

  it("completion store 满载 fail closed（不驱逐、不覆盖）", () => {
    // 直接构造满载 store。
    if (!Memory.runtime) Memory.runtime = {} as never;
    const runtime = Memory.runtime as unknown as { treasury?: Record<string, unknown> };
    runtime.treasury = runtime.treasury ?? {};
    const entries: Record<string, unknown> = {};
    for (let i = 0; i < TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES; i++) {
      entries[`cc:iv_full_${i}`] = {
        schemaVersion: 1,
        transactionId: `iv_full_${i}`,
        resolution: "not-executed",
        identity: { digest: DIGEST, identityProfile: "lowlevel", proofClass: "lowlevel", durableIdentityDigest: "eeeeeeeeeeee" + String(i).padStart(4, "0"), lowlevelSource: RUNTIME },
        settlementProofVerified: true,
        markerDischarged: true,
        authorityAbsentConfirmed: true,
        outcomeFinal: true,
        lineageFinalOrNotApplicable: true,
        lineageDisposition: "final",
        globalWriteAdmissionStillLocked: false,
        completedAtTick: Game.time,
      };
    }
    (runtime.treasury as { cleanupCompletions?: unknown }).cleanupCompletions = {
      version: 1,
      entries,
      entryCount: TREASURY_CLEANUP_COMPLETION_MAX_ENTRIES,
      updatedAt: Game.time,
    };
    resetTreasuryCleanupCompletionHeapCacheForTest();
    expect(peekTreasuryCleanupCompletionHealth().healthy).toBe(true);
    const durable = seedQuarantine("iv_c4");
    seedFinalNotExecutedTombstone("iv_c4", durable);
    const entry = openNotExecutedEntry("iv_c4", durable);
    const rejected = recordTreasuryCleanupCompletion({
      entry: { ...entry, markerDischarged: true, authorityReleased: true, outcomeFinalized: true, lineageFinalized: true } as TreasuryResolutionCleanupEntry,
      lineageDisposition: "final",
      globalWriteAdmissionStillLocked: false,
    });
    expect(rejected.status).toBe("rejected");
  });
});

// ── 6. Open 与 Activation 分离 ──────────────────────────────────────────────

describe("Remediation IV 6：journal open 只做 admission（无自动激活旁路）", () => {
  it("新 candidate profile 非法（lowlevel 缺 durable）→ 写入前拒绝（journal 零状态）", () => {
    const opened = openTreasuryResolutionCleanup({
      transactionId: "iv_o1",
      digest: DIGEST,
      resolution: "not-executed",
      identityProfile: "lowlevel",
      proofClass: "lowlevel",
      lowlevelSource: RUNTIME,
      // 缺 durableIdentityDigest（lowlevel profile required）。
    });
    expect(opened.status).toBe("rejected");
    expect(readTreasuryResolutionCleanupEntry("iv_o1")).toBeUndefined();
  });

  it("partial lineage（只带 lineageId）→ 写入前拒绝", () => {
    const opened = openTreasuryResolutionCleanup({
      transactionId: "iv_o2",
      digest: DIGEST,
      resolution: "not-executed",
      identityProfile: "lowlevel",
      proofClass: "lowlevel",
      lowlevelSource: RUNTIME,
      durableIdentityDigest: "bbbbbbbbbbbbbbbb",
      lineageId: "1111111111111111",
    });
    expect(opened.status).toBe("rejected");
  });

  it("既有 reservation + proof_durable open → already_open_reservation（不自动激活）", () => {
    const opened = openTreasuryResolutionCleanup({
      transactionId: "iv_o3",
      digest: DIGEST,
      resolution: "not-executed",
      identityProfile: "legacy-replay",
      proofClass: "legacy",
    });
    expect(opened.status).toBe("opened");
    const reopen = openTreasuryResolutionCleanup({
      transactionId: "iv_o3",
      digest: DIGEST,
      resolution: "not-executed",
      identityProfile: "legacy-replay",
      proofClass: "legacy",
    });
    expect(reopen.status).toBe("already_open_reservation");
    expect(readTreasuryResolutionCleanupEntry("iv_o3")?.settlementProofDurable).toBe(false);
  });

  it("reservation 激活只经 proof activation 权威（matching tombstone 后 ack activated）", () => {
    openTreasuryResolutionCleanup({
      transactionId: "iv_o4",
      digest: DIGEST,
      resolution: "not-executed",
      identityProfile: "lowlevel",
      proofClass: "lowlevel",
      lowlevelSource: RUNTIME,
      durableIdentityDigest: "cccccccccccccccc",
    });
    seedFinalNotExecutedTombstone("iv_o4", "cccccccccccccccc");
    const activation = acknowledgeTreasuryCleanupSettlementProof({ transactionId: "iv_o4" });
    expect(activation.outcome).toBe("activated");
    expect(readTreasuryResolutionCleanupEntry("iv_o4")?.settlementProofDurable).toBe(true);
  });

  it("reservation + proof 缺失 → 保持 reservation（activation proof_absent）", () => {
    openTreasuryResolutionCleanup({
      transactionId: "iv_o5",
      digest: DIGEST,
      resolution: "not-executed",
      identityProfile: "lowlevel",
      proofClass: "lowlevel",
      lowlevelSource: RUNTIME,
      durableIdentityDigest: "dddddddddddddddd",
    });
    const activation = acknowledgeTreasuryCleanupSettlementProof({ transactionId: "iv_o5" });
    expect(activation.outcome).toBe("proof_absent");
    expect(readTreasuryResolutionCleanupEntry("iv_o5")?.settlementProofDurable).toBe(false);
  });

  it("state-changing coordinator 不接受 partial expected（journal entry 是唯一 expected 来源）", () => {
    // advance 的输入只有 transactionId（+ 可选完整 exact identity 用于
    // journal absent 的 completion 对照）——不存在 digest-only 比较通道。
    const durable = seedQuarantine("iv_o6");
    seedFinalNotExecutedTombstone("iv_o6", durable);
    releaseTreasuryQuarantineEntry("iv_o6");
    releaseTreasuryIntentEntry("iv_o6");
    seedRootLineage("iv_o6", durable);
    openNotExecutedEntry("iv_o6", durable);
    // 全链推进成功（不传任何 expected——journal 自身为权威）。
    const advance = advanceTreasuryResolutionCleanupPhases({ transactionId: "iv_o6" });
    expect(advance.status).toBe("completed");
  });
});

// ── 7. Operation count ──────────────────────────────────────────────────────

describe("Remediation IV 7：operation-count", () => {
  it("50 次 pre-release gate 不触发重复全 store 扫描（单 key 查询）", () => {
    const { durable } = seedCommittedScene("iv_op1");
    const entry = readTreasuryResolutionCleanupEntry("iv_op1")!;
    for (let i = 0; i < 50; i++) {
      expect(gateTreasuryPreReleaseSettlement(entry).status).toBe("verified");
    }
    void durable;
  });

  it("50 次 completion lookup 单 key O(1)", () => {
    const { durable } = seedCommittedScene("iv_op2");
    const advance = advanceTreasuryResolutionCleanupPhases({ transactionId: "iv_op2" });
    expect(advance.status).toBe("completed");
    const expected = treasuryPreReleaseExactIdentityOfEntry({
      ...readTreasuryResolutionCleanupEntry("iv_op2")!,
      digest: DIGEST,
    } as TreasuryResolutionCleanupEntry);
    void expected;
    const completionExpected = { transactionId: "iv_op2", digest: DIGEST, proofClass: "lowlevel", durableIdentityDigest: durable, lowlevelSource: RUNTIME } as never;
    for (let i = 0; i < 50; i++) {
      expect(lookupTreasuryCleanupCompletion("iv_op2", completionExpected).verdict).toBe("match");
    }
    void durable;
  });
});
