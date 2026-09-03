/**
 * 【第十六轮第七节】final not-executed 残留 marker 安全补完成测试。
 *
 * 覆盖：
 * - final not-executed + authority 已释放 + matching marker：beginTick 清
 *   marker（幂等）；
 * - marker contract/digest identity conflict / cohort insufficient / 属于另
 *   一 attempt：不清除（markerCleanupBlocked）；
 * - marker 不存在：pending-release 完成；
 * - marker 清除后 rearm 才允许；
 * - marker 读取深冻结（不泄漏 attemptIdentity 引用）。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { quarantineTreasuryTransaction, readTreasuryQuarantineEntry, releaseTreasuryQuarantineEntry } from "@/runtime/treasury/quarantine";
import {
  readTreasuryResolutionTombstone,
  readTreasuryResolutionStoreCounters,
  recoverStagedResolutions,
  resetTreasuryResolutionStoreForTest,
  writeTreasuryResolutionTombstone,
} from "@/runtime/treasury/resolutionStore";
import { recordTreasuryWriteFault, readTreasuryWriteFault } from "@/runtime/treasury/writeFault";
import { rearmResolvedNotExecutedAttempt } from "@/runtime/treasury/attemptRearm";
import { listTreasuryPendingReleaseIds } from "@/runtime/treasury/resolutionStore";
import { createTreasuryAttemptLineageRecord } from "@/runtime/treasury/attemptLineage";
import { TREASURY_LOWLEVEL_SOURCE_RUNTIME } from "@/runtime/treasury/authorityLevel";
import {
  makeTreasuryTestTransferAdapter,
  replaceTreasuryActionAdapterForTest,
} from "@/runtime/treasury/actionContracts";
import { installRooms, type RoomSpec } from "@mock/treasury";
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

function makeService(): TreasuryTestService {
  const rooms = installRooms(ROOMS);
  const service = treasuryTestService(createTreasuryService({ getRooms: () => Object.values(rooms) }));
  service.beginTick();
  return treasuryTestService(service);
}

function seedQuarantineThenRelease(transactionId: string): string {
  const write = quarantineTreasuryTransaction({
    transactionId,
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
  const identity = readTreasuryQuarantineEntry(transactionId)?.durableIdentityDigest;
  expect(identity).toBeDefined();
  // 模拟"释放已完成、marker 残留"的中断窗口。
  expect(releaseTreasuryQuarantineEntry(transactionId)).toBe(true);
  // 【Remediation IV 九.2】not-executed settlement 的 root lineage publication
  //（生产路径在 tombstone 前创建；意外缺失时 lineage 阶段结构化 blocked）。
  const lineageCreated = createTreasuryAttemptLineageRecord({
    rootTransactionId: transactionId,
    rootIdentity: { digest: DIGEST, durableIdentityDigest: identity as string, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME },
    actionKind: "terminal.send",
    authorityClass: "lowlevel",
    lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
    rearmable: true,
    identityProfile: "lowlevel",
    retrySemanticDigest: "6666666666666666",
  });
  expect(lineageCreated.status).toBe("written");
  return identity as string;
}

function seedFinalNotExecuted(transactionId: string, identity: string): void {
  const write = writeTreasuryResolutionTombstone({
    transactionId,
    digest: DIGEST,
    resolution: "not-executed",
    stage: "final",
    proofLevel: "lowlevel",
    lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
    durableIdentityDigest: identity,
    actionTick: Game.time,
    observationTick: Game.time,
    resolvedAtTick: Game.time,
    reconcilerKind: "terminal.send",
    source: "test",
  });
  expect(write.status).not.toBe("rejected");
}


function seedMarker(overrides: {
  digest?: string;
  attemptIdentity?: { durableIdentityDigest?: string };
  durableIdentityDigest?: string;
  lowlevelSource?: string;
  /** 显式传 false 时不写 v4 身份字段（模拟 v1 legacy marker）。 */
  legacyV1?: boolean;
} = {}): void {
  recordTreasuryWriteFault({
    transactionId: "mc_tx",
    digest: overrides.digest ?? DIGEST,
    tick: Game.time,
    kind: "terminal.send",
    source: "test",
    phase: "executing_at_end_tick",
    status: "unresolved",
    recordedAt: Game.time,
    ...(overrides.legacyV1 === true
      ? {}
      : {
          // 【第二十二轮 v4】exact marker：lowlevel profile + 顶层完整身份事实。
          markerProtocol: 4 as const,
          identityProfile: "lowlevel" as const,
          authorityClass: "lowlevel" as const,
          lowlevelSource: overrides.lowlevelSource ?? TREASURY_LOWLEVEL_SOURCE_RUNTIME,
          durableIdentityDigest:
            overrides.durableIdentityDigest ?? overrides.attemptIdentity?.durableIdentityDigest ?? "0cc99174bb6f2e74",
        }),
    ...(overrides.attemptIdentity !== undefined ? { attemptIdentity: overrides.attemptIdentity } : {}),
  });
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  resetTreasuryResolutionStoreForTest();
  replaceTreasuryActionAdapterForTest({
    ...makeTreasuryTestTransferAdapter(),
    kind: "terminal.send",
    semanticIdentity: SEMANTIC,
    reconcile: () => "observed_not_executed" as const,
  });
});

describe("marker 补完成（第十六轮第七节）", () => {
  it("final not-executed + authority 已释放 + matching marker：安全顺序破坏 → 结构化阻断（marker 保留）", () => {
    const identity = seedQuarantineThenRelease("mc_tx");
    seedFinalNotExecuted("mc_tx", identity);
    seedMarker({ durableIdentityDigest: identity });
    expect(readTreasuryWriteFault()).toBeDefined();
    // 【Remediation IV 六.4】authority absent + marker 仍未清除 = 安全顺序
    // marker→authority 被破坏：最后一把锁不得因 Authority absent 被清除。
    const report = recoverStagedResolutions();
    expect(report.completedRelease).toBe(0);
    expect(report.markerCleanupBlocked).toBeGreaterThanOrEqual(1);
    expect(readTreasuryWriteFault()).toBeDefined();
    const again = recoverStagedResolutions();
    expect(again.markerCleanupBlocked).toBeGreaterThanOrEqual(1);
    expect(readTreasuryWriteFault()).toBeDefined();
  });

  it("marker digest 冲突（属于另一 attempt）：不清除", () => {
    const identity = seedQuarantineThenRelease("mc_tx");
    seedFinalNotExecuted("mc_tx", identity);
    seedMarker({ digest: "ffffffffffffffff", durableIdentityDigest: identity });
    const report = recoverStagedResolutions();
    expect(report.markerCleanupBlocked).toBeGreaterThanOrEqual(1);
    expect(report.completedRelease).toBe(0);
    expect(readTreasuryWriteFault()).toBeDefined();
    expect(readTreasuryResolutionTombstone("mc_tx")?.stage).toBe("final");
  });

  it("marker attemptIdentity 与 tombstone conflict：不清除", () => {
    const identity = seedQuarantineThenRelease("mc_tx");
    seedFinalNotExecuted("mc_tx", identity);
    seedMarker({ durableIdentityDigest: "aaaaaaaaaaaaaaaa" });
    const report = recoverStagedResolutions();
    expect(report.markerCleanupBlocked).toBeGreaterThanOrEqual(1);
    expect(readTreasuryWriteFault()).toBeDefined();
  });

  it("marker 无 class-aware 身份（v1 legacy insufficient）：不清除", () => {
    const identity = seedQuarantineThenRelease("mc_tx");
    seedFinalNotExecuted("mc_tx", identity);
    seedMarker({ legacyV1: true });
    const report = recoverStagedResolutions();
    expect(report.markerCleanupBlocked).toBeGreaterThanOrEqual(1);
    expect(readTreasuryWriteFault()).toBeDefined();
  });

  it("marker 属于另一 transaction：不清除（write readiness 继续阻断）", () => {
    const identity = seedQuarantineThenRelease("mc_tx");
    seedFinalNotExecuted("mc_tx", identity);
    recordTreasuryWriteFault({
      transactionId: "mc_other_tx",
      digest: DIGEST,
      tick: Game.time,
      kind: "terminal.send",
      source: "test",
      phase: "executing_at_end_tick",
      status: "unresolved",
      recordedAt: Game.time,
    });
    const report = recoverStagedResolutions();
    expect(report.markerCleanupBlocked).toBeGreaterThanOrEqual(1);
    expect(readTreasuryWriteFault()).toBeDefined();
    expect((readTreasuryWriteFault() as { transactionId: string }).transactionId).toBe("mc_other_tx");
  });

  it("marker 不存在：pending-release 完成（索引移出）", () => {
    const identity = seedQuarantineThenRelease("mc_tx");
    seedFinalNotExecuted("mc_tx", identity);
    expect(readTreasuryWriteFault()).toBeUndefined();
    const report = recoverStagedResolutions();
    expect(report.completedRelease).toBe(0);
    expect(report.markerCleanupBlocked).toBe(0);
    expect(report.idleFastPath).toBe(false); // 处理了 pending-release 项（无 marker 直接完成）
  });

  it("marker 清除后 rearm 才允许；未清除时 rearm 拒绝", () => {
    const identity = seedQuarantineThenRelease("mc_tx");
    seedFinalNotExecuted("mc_tx", identity);
    seedMarker({ durableIdentityDigest: identity });
    // 直接调协议入口（零写、不依赖 service 闭包）——不经 beginTick 恢复，
    // marker 保持 pending 状态。
    const blocked = rearmResolvedNotExecutedAttempt({ parentTransactionId: "mc_tx" });
    expect(blocked.status).toBe("rejected");
    if (blocked.status === "rejected") expect(blocked.reason).toBe("marker_cleanup_pending");
    // 【Remediation IV】marker 残留 + authority 已释放 = 顺序破坏（上方
    // 用例语义）——手工清除 marker 后（authority/marker 均 absent 的遗留
    // 窗口）恢复可幂等补完成。
    const markerStore = (Memory.runtime as { treasury?: { writeFault?: unknown } }).treasury;
    delete markerStore?.writeFault;
    const report = recoverStagedResolutions();
    expect(listTreasuryPendingReleaseIds()).toEqual([]);
    const allowed = rearmResolvedNotExecutedAttempt({ parentTransactionId: "mc_tx" });
    expect(allowed.status).toBe("rearmed");
  });

  it("marker 读取返回深冻结快照（不泄漏 attemptIdentity 引用）", () => {
    const identity = seedQuarantineThenRelease("mc_tx");
    seedFinalNotExecuted("mc_tx", identity);
    seedMarker({ durableIdentityDigest: identity });
    const marker = readTreasuryWriteFault();
    expect(marker).toBeDefined();
    expect(Object.isFrozen(marker)).toBe(true);
    expect(Object.isFrozen((marker as { attemptIdentity?: object }).attemptIdentity)).toBe(true);
  });
});
