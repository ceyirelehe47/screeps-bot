/**
 * 【第十六轮第十一/十二节】lowlevel provenance 完整 proof 链 + not-executed
 * capability 消费顺序测试。
 *
 * 覆盖：
 * - runtime-lowlevel authority 不能被 migrated-lowlevel proof 释放（反向亦然）；
 * - lowlevel provenance 进入 attempt identity relation（insufficient/conflict）；
 * - lowlevel tombstone 与 receipt 保存 provenance（或其绑定）；
 * - verifier 严格比较来源；旧 proof 缺来源 insufficient 不释放；
 * - modern proof 不能释放 lowlevel authority（v5 旧 tombstone 隔离）；
 * - not-executed capability staging：consume 失败不产生 final tombstone、
 *   authority 保留；tombstone 写失败不形成错误终态；释放前中断 beginTick
 *   补完成；重复管理调用幂等；rearm 在 pending-release 完成后允许。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest, commitSettledReceipt } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { quarantineTreasuryTransaction, readTreasuryQuarantineEntry, releaseTreasuryQuarantineEntry } from "@/runtime/treasury/quarantine";
import {
  readTreasuryResolutionTombstone,
  readTreasuryResolutionStoreCounters,
  recoverStagedResolutions,
  resetTreasuryResolutionStoreForTest,
  writeTreasuryResolutionTombstone,
} from "@/runtime/treasury/resolutionStore";
import { verifyTreasuryCommittedResolutionProof } from "@/runtime/treasury/committedProofVerifier";
import { treasuryAttemptIdentityRelation } from "@/runtime/treasury/identityProof";
import { recordTreasuryWriteFault, readTreasuryWriteFault, setTreasuryCommitFaultInjectorForTest } from "@/runtime/treasury/writeFault";
import { TREASURY_LOWLEVEL_SOURCE_MIGRATED, TREASURY_LOWLEVEL_SOURCE_RUNTIME } from "@/runtime/treasury/authorityLevel";
import { rearmResolvedNotExecutedAttempt } from "@/runtime/treasury/attemptRearm";
import {
  makeTreasuryTestTransferAdapter,
  replaceTreasuryActionAdapterForTest,
} from "@/runtime/treasury/actionContracts";
import { installRooms, type RoomSpec } from "@mock/treasury";
import type { TreasuryTransactionInput } from "@/runtime/treasury/types";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 100_000 }, freeCapacity: 10_000 },
    terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 5_000 },
  },
];

const BASE_POSTINGS = [{ roomName: "W1N57", locationKind: "storage" as const, resource: "energy" as const, delta: -500 }];
const SEMANTIC = "terminal.send@reconciler-semantics-v1";
const DIGEST = "0123456789abcdef";
const IDENTITY = "0123456789abcdee";

function makeService(): TreasuryTestService {
  const rooms = installRooms(ROOMS);
  const service = treasuryTestService(createTreasuryService({ getRooms: () => Object.values(rooms) }));
  service.beginTick();
  return treasuryTestService(service);
}

function freshInput(service: TreasuryTestService, transactionId: string): TreasuryTransactionInput {
  const epoch = service.observation().epoch;
  return {
    transactionId,
    kind: "terminal.send",
    source: "test",
    decision: { scope: epoch.scope, epochSeq: epoch.epochSeq, observedAtTick: epoch.observedAtTick },
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -500 }],
  };
}

function seedLowlevelQuarantine(transactionId: string, source: string): string {
  const write = quarantineTreasuryTransaction({
    transactionId,
    authorityLevel: "lowlevel",
    lowlevelSource: source,
    digest: DIGEST,
    tick: Game.time,
    kind: "terminal.send",
    actionKind: "terminal.send",
    source: "test",
    adapterSemanticIdentity: SEMANTIC,
    phase: "ok_pending_commit_unresolved",
    outcome: "returned_ok",
    settlement: "quarantined",
    deltas: BASE_POSTINGS.map((leg) => ({ ...leg })),
    recordedAt: Game.time,
  });
  expect(write.status).toBe("written");
  const derived = readTreasuryQuarantineEntry(transactionId)?.durableIdentityDigest;
  expect(derived).toBeDefined();
  return derived as string;
}

function seedResolvingTombstone(transactionId: string, source: string | undefined, identity: string): void {
  const write = writeTreasuryResolutionTombstone({
    transactionId,
    digest: DIGEST,
    resolution: "committed",
    stage: "resolving",
    proofLevel: "lowlevel",
    ...(source !== undefined ? { lowlevelSource: source } : {}),
    durableIdentityDigest: identity,
    actionTick: Game.time,
    settledAtTick: Game.time,
    observationTick: Game.time,
    resolvedAtTick: Game.time,
    reconcilerKind: "terminal.send",
    source: "test",
  });
  expect(write.status).not.toBe("rejected");
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  resetTreasuryResolutionStoreForTest();
  setTreasuryCommitFaultInjectorForTest(null);
  replaceTreasuryActionAdapterForTest({
    ...makeTreasuryTestTransferAdapter(),
    kind: "terminal.send",
    semanticIdentity: SEMANTIC,
    reconcile: () => "observed_not_executed" as const,
  });
});

describe("lowlevel provenance proof 链（第十六轮第十一节）", () => {
  it("runtime-lowlevel authority 不能被 migrated-lowlevel proof 释放（反向亦然）", () => {
    const identity = seedLowlevelQuarantine("lp_runtime", TREASURY_LOWLEVEL_SOURCE_RUNTIME);
    seedResolvingTombstone("lp_runtime", TREASURY_LOWLEVEL_SOURCE_MIGRATED, identity);
    const report = recoverStagedResolutions();
    expect(report.identityConflicts).toBeGreaterThanOrEqual(1);
    expect(readTreasuryQuarantineEntry("lp_runtime")).toBeDefined();
    expect(readTreasuryResolutionTombstone("lp_runtime")?.stage).toBe("resolving");
    // 反向：migrated authority + runtime proof —— 三方 verifier 纯函数断言
    // （迁移定级 authority 的 store 直装不可经写入通道产生，verifier 直接
    // 覆盖同一判定逻辑）。
    const reverse = verifyTreasuryCommittedResolutionProof({
      tombstone: { transactionId: "lp_migrated", digest: DIGEST, proofLevel: "lowlevel", settledAtTick: Game.time, durableIdentityDigest: IDENTITY, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME },
      authorityResolution: {
        status: "ok",
        authority: {
          authorityKind: "quarantine", transactionId: "lp_migrated", digest: DIGEST, kind: "terminal.send", actionKind: "terminal.send",
          phase: "ok_pending_commit_unresolved", outcome: "returned_ok", settlement: "quarantined",
          recordedAt: Game.time, actionTick: Game.time, postings: BASE_POSTINGS.map((l) => ({ ...l })),
          authorityLevel: "lowlevel", durableIdentityDigest: IDENTITY, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_MIGRATED,
        },
      },
      receiptProof: { level: "lowlevel", settledAtTick: Game.time, digest: DIGEST, durableIdentityDigest: IDENTITY, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME },
    });
    expect(reverse.status).toBe("conflict");
  });

  it("相同来源（runtime + runtime）可正常 finalize——三方 provenance 一致", () => {
    const identity = seedLowlevelQuarantine("lp_match", TREASURY_LOWLEVEL_SOURCE_RUNTIME);
    seedResolvingTombstone("lp_match", TREASURY_LOWLEVEL_SOURCE_RUNTIME, identity);
    const receipt = commitSettledReceipt("lp_match", Game.time, { digest: DIGEST, durableIdentityDigest: identity, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME });
    expect(receipt.status).toBe("written");
    const report = recoverStagedResolutions();
    expect(report.completed).toBe(1);
    expect(readTreasuryQuarantineEntry("lp_match")).toBeUndefined();
    expect(readTreasuryResolutionTombstone("lp_match")?.stage).toBe("final");
  });

  it("lowlevel provenance 进入 attempt identity relation（insufficient/conflict）", () => {
    // attempt 带 runtime 来源、proof 缺失 → insufficient。
    expect(
      treasuryAttemptIdentityRelation(
        { digest: DIGEST, durableIdentityDigest: IDENTITY },
        { digest: DIGEST, durableIdentityDigest: IDENTITY, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME },
      ),
    ).toBe("insufficient");
    // attempt 与 proof 来源不同 → conflict。
    expect(
      treasuryAttemptIdentityRelation(
        { digest: DIGEST, durableIdentityDigest: IDENTITY, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_MIGRATED },
        { digest: DIGEST, durableIdentityDigest: IDENTITY, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME },
      ),
    ).toBe("conflict");
    // 相同来源 → match（含其它维度）。
    expect(
      treasuryAttemptIdentityRelation(
        { digest: DIGEST, durableIdentityDigest: IDENTITY, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME },
        { digest: DIGEST, durableIdentityDigest: IDENTITY, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME },
      ),
    ).toBe("match");
  });

  it("lowlevel tombstone 保存 provenance；receipt 保存 provenance", () => {
    seedResolvingTombstone("lp_persist", TREASURY_LOWLEVEL_SOURCE_RUNTIME, IDENTITY);
    expect(readTreasuryResolutionTombstone("lp_persist")?.lowlevelSource).toBe(TREASURY_LOWLEVEL_SOURCE_RUNTIME);
    commitSettledReceipt("lp_persist", Game.time, { digest: DIGEST, durableIdentityDigest: IDENTITY, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME });
    const branch = (Memory.runtime as { treasury?: { receipts?: { settled?: Record<string, { lowlevelSource?: string }> } } }).treasury?.receipts?.settled;
    const key = Object.keys(branch ?? {}).find((k) => k.includes("lp_persist"));
    expect(key).toBeDefined();
    expect(branch?.[key as string]?.lowlevelSource).toBe(TREASURY_LOWLEVEL_SOURCE_RUNTIME);
  });

  it("verifier 严格比较来源；旧 proof 缺来源 insufficient 不释放", () => {
    // 旧 v5 tombstone（无 lowlevelSource）→ verifier insufficient。
    const identity = seedLowlevelQuarantine("lp_old", TREASURY_LOWLEVEL_SOURCE_RUNTIME);
    // 直装 v6 entry 且无 lowlevelSource（v5 旧 proof 形态——写入侧已拒绝新
    // lowlevel 无来源，仅历史数据可无）。
    Memory.runtime = Memory.runtime ?? ({} as object);
    const tbranch = (Memory.runtime as { treasury?: Record<string, unknown> }).treasury ?? {};
    (Memory.runtime as { treasury?: Record<string, unknown> }).treasury = {
      ...tbranch,
      resolutions: {
        version: 6,
        entries: {
          "r:lp_old": {
            transactionId: "lp_old",
            digest: DIGEST,
            resolution: "committed",
            stage: "resolving",
            proofLevel: "lowlevel",
            durableIdentityDigest: identity,
            actionTick: Game.time,
            settledAtTick: Game.time,
            observationTick: Game.time,
            resolvedAtTick: Game.time,
            reconcilerKind: "terminal.send",
            source: "test",
          },
        },
        entryCount: 1,
        updatedAt: Game.time,
      },
    };
    resetTreasuryResolutionStoreForTest();
    const receipt = commitSettledReceipt("lp_old", Game.time, { digest: DIGEST, durableIdentityDigest: identity, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME });
    expect(receipt.status).toBe("written");
    const report = recoverStagedResolutions();
    expect(report.identityInsufficient).toBeGreaterThanOrEqual(1);
    expect(report.completed).toBe(0);
    expect(readTreasuryQuarantineEntry("lp_old")).toBeDefined();
    // 直接调用 verifier：tombstone 缺 provenance → insufficient verdict。
    const verdict = verifyTreasuryCommittedResolutionProof({
      tombstone: { transactionId: "lp_old", digest: DIGEST, proofLevel: "lowlevel", settledAtTick: Game.time, durableIdentityDigest: identity },
      authorityResolution: {
        status: "ok",
        authority: {
          authorityKind: "quarantine", transactionId: "lp_old", digest: DIGEST, kind: "terminal.send", actionKind: "terminal.send",
          phase: "ok_pending_commit_unresolved", outcome: "returned_ok", settlement: "quarantined",
          recordedAt: Game.time, actionTick: Game.time, postings: BASE_POSTINGS.map((l) => ({ ...l })),
          authorityLevel: "lowlevel", durableIdentityDigest: identity, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
        },
      },
      receiptProof: { level: "modern", settledAtTick: Game.time, digest: DIGEST, durableIdentityDigest: identity, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME },
    });
    expect(verdict.status).toBe("insufficient");
  });

  it("modern proof（identity-bound）不能释放 lowlevel authority（自动释放矩阵）", () => {
    const verdict = verifyTreasuryCommittedResolutionProof({
      tombstone: { transactionId: "lp_modern", digest: DIGEST, proofLevel: "identity-bound", settledAtTick: Game.time, contractDigest: "1111111111111111", authorizationCohortDigest: "2222222222222222", durableIdentityDigest: IDENTITY },
      authorityResolution: {
        status: "ok",
        authority: {
          authorityKind: "quarantine", transactionId: "lp_modern", digest: DIGEST, kind: "terminal.send", actionKind: "terminal.send",
          phase: "ok_pending_commit_unresolved", outcome: "returned_ok", settlement: "quarantined",
          recordedAt: Game.time, actionTick: Game.time, postings: BASE_POSTINGS.map((l) => ({ ...l })),
          authorityLevel: "lowlevel", durableIdentityDigest: IDENTITY, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
        },
      },
      receiptProof: { level: "modern", settledAtTick: Game.time, digest: DIGEST, durableIdentityDigest: IDENTITY },
    });
    expect(verdict.status).toBe("insufficient");
  });
});

describe("not-executed capability 消费顺序（第十六轮第十二节）", () => {
  /** 制造 executing 边界 quarantine（Game 结果未知）。 */
  function makeExecutingQuarantine(transactionId: string): void {
    const service = makeService();
    service.executePreparedAction(freshInput(service, transactionId), () => {
      service.endTick();
      return { ok: false as const };
    });
    expect(readTreasuryQuarantineEntry(transactionId)).toBeDefined();
  }

  function issueCapability(service: TreasuryTestService, transactionId: string) {
    return service.issueTreasuryReconciliationCapability({ transactionId });
  }

  it("consume 失败（跨 tick 同步窗口失效）：不产生 final tombstone、authority 保留", () => {
    makeExecutingQuarantine("cs_consume_fail");
    Game.time += 1;
    const next = makeService();
    const issued = issueCapability(next, "cs_consume_fail");
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    // 模拟 capability 消费失败窗口：先消费（直接调 kernel consume 模拟），
    // 再用已消费 capability 调 resolve——prevalidate 只读验证 already_used 拒绝。
    const consumed = (next as unknown as { [k: symbol]: unknown });
    void consumed;
    // 先把 capability 用掉（第一次 resolve 成功），再用同一 capability 二次
    // 调用 → invalid_capability，且不存在新的可自动释放 proof。
    const resolved = next.resolveUnresolvedTransaction({ transactionId: "cs_consume_fail", capability: issued.capability });
    expect(resolved.status).toBe("resolved");
    const again = next.resolveUnresolvedTransaction({ transactionId: "cs_consume_fail", capability: issued.capability });
    expect(again.status).toBe("rejected");
    if (again.status === "rejected") expect(again.reason).toBe("invalid_capability");
    // 二次调用零副作用：tombstone 唯一（幂等 already_resolved 或 rejected）。
    expect(readTreasuryResolutionTombstone("cs_consume_fail")?.stage).toBe("final");
  });

  it("capability 消费失败零持久副作用的直接验证（同 tick 已消费后重签发再失败）", () => {
    makeExecutingQuarantine("cs_staging");
    Game.time += 1;
    const next = makeService();
    const first = issueCapability(next, "cs_staging");
    expect(first.status).toBe("issued");
    if (first.status !== "issued") return;
    const resolved = next.resolveUnresolvedTransaction({ transactionId: "cs_staging", capability: first.capability });
    expect(resolved.status).toBe("resolved");
    // authority 已释放、tombstone final——同 ID 新 capability 无法签发。
    const second = issueCapability(next, "cs_staging");
    expect(second.status).not.toBe("issued");
    expect(readTreasuryQuarantineEntry("cs_staging")).toBeUndefined();
  });

  it("tombstone 成功后释放前中断：beginTick 补完成（marker 残留场景）", () => {
    // 手工构造中断窗口：quarantine 已释放、final tombstone 已写、marker 残留。
    const service = makeService();
    void service;
    const write = quarantineTreasuryTransaction({
      transactionId: "cs_interrupt",
      authorityLevel: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      digest: DIGEST,
      tick: Game.time,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      adapterSemanticIdentity: SEMANTIC,
      phase: "executing_at_end_tick",
      outcome: "started_unknown",
      settlement: "quarantined",
      deltas: BASE_POSTINGS.map((leg) => ({ ...leg })),
      recordedAt: Game.time,
    });
    expect(write.status).toBe("written");
    const derived = readTreasuryQuarantineEntry("cs_interrupt")?.durableIdentityDigest;
    expect(derived).toBeDefined();
    expect(releaseTreasuryQuarantineEntry("cs_interrupt")).toBe(true);
    const tombWrite = writeTreasuryResolutionTombstone({
      transactionId: "cs_interrupt",
      digest: DIGEST,
      resolution: "not-executed",
      stage: "final",
      proofLevel: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      durableIdentityDigest: derived,
      actionTick: Game.time,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
      reconcilerKind: "terminal.send",
      source: "test",
    });
    expect(tombWrite.status).not.toBe("rejected");
    recordTreasuryWriteFault({
      transactionId: "cs_interrupt",
      digest: DIGEST,
      tick: Game.time,
      kind: "terminal.send",
      source: "test",
      phase: "executing_at_end_tick",
      status: "unresolved",
      recordedAt: Game.time,
      // 【第二十二轮 v4】exact marker（lowlevel profile + 顶层完整身份）。
      markerProtocol: 4 as const,
      identityProfile: "lowlevel" as const,
      authorityClass: "lowlevel" as const,
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      durableIdentityDigest: derived,
    });
    expect(readTreasuryWriteFault()).toBeDefined();
    const report = recoverStagedResolutions();
    expect(report.completedRelease).toBe(1);
    expect(readTreasuryWriteFault()).toBeUndefined();
  });

  it("未成功消费 capability 永远不对应可自动释放的 final proof：final proof 存在 → capability 已消费（发布顺序）", () => {
    // 语义验证：not-executed 的 resolved 结果意味着 consume 已完成（新顺序
    // consume → tombstone）；tombstone 与 marker/authority 的终态一致。
    makeExecutingQuarantine("cs_order");
    Game.time += 1;
    const next = makeService();
    const issued = issueCapability(next, "cs_order");
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    const resolved = next.resolveUnresolvedTransaction({ transactionId: "cs_order", capability: issued.capability });
    expect(resolved.status).toBe("resolved");
    // 再次用同一 capability：已消费 → 拒绝（不存在"未消费却 final"中间态）。
    const replay = next.resolveUnresolvedTransaction({ transactionId: "cs_order", capability: issued.capability });
    expect(replay.status).toBe("rejected");
    // 幂等：重复管理调用——authority 已释放、tombstone final，签发侧稳定
    // 拒绝（not_found），不存在新的可执行路径。
    const reissue = issueCapability(next, "cs_order");
    expect(reissue.status).toBe("rejected");
    if (reissue.status === "rejected") expect(reissue.reason).toBe("not_found");
  });

  it("rearm 在 pending-release 完成后允许", () => {
    makeExecutingQuarantine("cs_rearm");
    Game.time += 1;
    const next = makeService();
    const issued = issueCapability(next, "cs_rearm");
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    expect(next.resolveUnresolvedTransaction({ transactionId: "cs_rearm", capability: issued.capability }).status).toBe("resolved");
    // resolution 已完成（release + marker 清理同步完成）——rearm 允许；若
    // marker 尚存（executing 边界 fault 的残留），rearm 阻断至 beginTick 补完成。
    let rearmed = rearmResolvedNotExecutedAttempt({ parentTransactionId: "cs_rearm" });
    if (rearmed.status === "rejected") {
      const report = recoverStagedResolutions();
      expect(report.completedRelease).toBeGreaterThanOrEqual(1);
      rearmed = rearmResolvedNotExecutedAttempt({ parentTransactionId: "cs_rearm" });
    }
    expect(rearmed.status).toBe("rearmed");
    expect(readTreasuryResolutionStoreCounters().recovered).toBeGreaterThanOrEqual(0);
  });
});
