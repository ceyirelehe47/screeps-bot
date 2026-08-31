/**
 * 第十一轮 3.13.6：outcome/settlement/phase 语义矩阵与 cross-store
 * finalized proof 测试。
 *
 * - 非法组合（returned_ok+pending_abort、returned_non_ok+pending_commit、
 *   not_started+pending_commit、quarantine commit phase+started_unknown）
 *   使 store unhealthy（load fatal）→ write readiness=false；
 * - progressTreasuryIntent 的目标组合过矩阵（outcome 单调合法但组合非法
 *   → invalid_phase 拒绝）；
 * - finalized proof 两态（有 proof 释放/幂等；无 proof 保留 semantic fault）。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import {
  peekTreasuryIntentHealth,
  progressTreasuryIntent,
  resetTreasuryIntentRuntimeForTest,
  writeTreasuryIntentEntry,
} from "@/runtime/treasury/intents";
import {
  peekTreasuryQuarantineHealth,
  quarantineTreasuryTransaction,
  resetTreasuryQuarantineRuntimeForTest,
} from "@/runtime/treasury/quarantine";
import { registerTreasuryActionAdapter, makeTreasuryTestTransferAdapter } from "@/runtime/treasury/actionContracts";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import { registerTreasuryPolicyResolver, makeNoReserveTreasuryPolicy } from "@/runtime/treasury/policyAuthority";
import { installRooms, type RoomSpec } from "@mock/treasury";
import { writeTreasuryResolutionTombstone } from "@/runtime/treasury/resolutionStore";
import { readTreasuryIntentEntry } from "@/runtime/treasury/intents";
import { computeTreasuryDurableIdentityDigest } from "@/runtime/treasury/durableIdentity";

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

function seedExecutingIntent(transactionId: string): void {
  const write = writeTreasuryIntentEntry({
    transactionId,
    digest: "0123456789abcdef",
    actionKind: "test.transfer",
    kind: "test.transfer",
    source: "test",
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -100 }],
    outcome: "started_unknown",
    settlement: "executing",
    createdAtTick: Game.time,
    updatedAtTick: Game.time,
  });
  expect(write.status).toBe("written");
}

function seedCorruptIntentEntry(outcome: string, settlement: string): void {
  // 懒初始化：先写合法 entry 创建 store，再覆盖损坏组合 entry。
  seedExecutingIntent("sm_seed_init");
  // 【第十四轮】手塞的低层 entry 须满足严格低层矩阵（lowlevelSource 来源
  // 标记 + 由事实真实派生的 durableIdentityDigest）——否则损坏先被
  // authority 矩阵抓到（测不到本用例针对的语义矩阵违规）。
  (Memory.runtime!.treasury!.intents as unknown as { entries: Record<string, unknown> }).entries["i:sm_corrupt"] = {
    transactionId: "sm_corrupt",
    authorityLevel: "lowlevel",
    lowlevelSource: "runtime-lowlevel@v1",
    durableIdentityDigest: computeTreasuryDurableIdentityDigest({
      transactionId: "sm_corrupt",
      digest: "0123456789abcdef",
      actionKind: "test.transfer",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -100 }],
      source: "test",
    }),
    digest: "0123456789abcdef",
    actionKind: "test.transfer",
    kind: "test.transfer",
    source: "test",
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -100 }],
    outcome,
    settlement,
    createdAtTick: Game.time,
    updatedAtTick: Game.time,
  };
  (Memory.runtime!.treasury!.intents as unknown as { entryCount: number }).entryCount = 2;
  resetTreasuryIntentRuntimeForTest();
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  registerTreasuryActionAdapter(makeTreasuryTestTransferAdapter());
  registerTreasuryPolicyResolver(makeNoReserveTreasuryPolicy());
});

describe("outcome/settlement/phase 语义矩阵（第十一轮 3.13.6）", () => {
  it("progressTreasuryIntent：outcome 单调合法但组合非法 → 语义矩阵拒绝", () => {
    seedExecutingIntent("sm_progress");
    // started_unknown → returned_ok 单调合法，但 returned_ok 不得进入 pending_abort。
    const bad = progressTreasuryIntent("sm_progress", { outcome: "returned_ok", settlement: "pending_abort", fromSettlement: ["executing"] });
    expect(bad.status).toBe("rejected");
    if (bad.status === "rejected") {
      expect(bad.reason).toBe("invalid_phase");
      expect(bad.detail).toContain("语义矩阵");
    }
    // 合法组合仍通过（returned_ok → pending_commit）。
    const good = progressTreasuryIntent("sm_progress", { outcome: "returned_ok", settlement: "pending_commit", fromSettlement: ["executing"] });
    expect(good.status).toBe("marked");
  });

  it("returned_ok + pending_abort 损坏数据 → intent store unhealthy + write readiness=false", () => {
    seedCorruptIntentEntry("returned_ok", "pending_abort");
    // 触发 load（peek 是轻量探测——entry 级损坏由 load 显式检出）。
    const loadProbe = progressTreasuryIntent("sm_corrupt", { outcome: "started_unknown", settlement: "executing" });
    expect(loadProbe.status).toBe("rejected");
    expect(peekTreasuryIntentHealth().healthy).toBe(false);
    expect(peekTreasuryIntentHealth().detail).toContain("语义矩阵");
    const service = makeService();
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.writeAdmission.ready).toBe(false);
    expect(view.writeAdmission.blockers).toContain("intent_unhealthy");
  });

  it("returned_non_ok + pending_commit / not_started + pending_commit 均非法", () => {
    seedCorruptIntentEntry("returned_non_ok", "pending_commit");
    expect(progressTreasuryIntent("sm_corrupt", { outcome: "started_unknown", settlement: "executing" }).status).toBe("rejected");
    expect(peekTreasuryIntentHealth().healthy).toBe(false);
    clearTreasuryPersistenceForTest();
    seedCorruptIntentEntry("not_started", "pending_commit");
    expect(progressTreasuryIntent("sm_corrupt", { outcome: "started_unknown", settlement: "executing" }).status).toBe("rejected");
    expect(peekTreasuryIntentHealth().healthy).toBe(false);
  });

  it("quarantine commit phase + started_unknown outcome → store unhealthy（phase/outcome 矩阵）", () => {
    quarantineTreasuryTransaction({
      transactionId: "sm_q_init",
      digest: "0123456789abcdef",
      tick: Game.time,
      kind: "test.transfer",
      source: "test",
      phase: "action_threw_execution_unknown",
      deltas: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -100 }],
      recordedAt: Game.time,
      outcome: "started_unknown",
      settlement: "quarantined",
    } as never);
    (Memory.runtime!.treasury!.quarantine as unknown as { entries: Record<string, unknown> }).entries["q:sm_q_corrupt"] = {
      transactionId: "sm_q_corrupt",
      digest: "0123456789abcdef",
      tick: Game.time,
      kind: "test.transfer",
      source: "test",
      phase: "commit_unexpected",
      deltas: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -100 }],
      recordedAt: Game.time,
      outcome: "started_unknown",
      settlement: "quarantined",
    };
    (Memory.runtime!.treasury!.quarantine as unknown as { entryCount: number }).entryCount = 2;
    resetTreasuryQuarantineRuntimeForTest();
    // 触发 load：损坏 entry 检出 fatal。
    const loadProbe = quarantineTreasuryTransaction({
      transactionId: "sm_q_probe",
      digest: "0123456789abcdef",
      tick: Game.time,
      kind: "test.transfer",
      source: "test",
      phase: "action_threw_execution_unknown",
      deltas: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -100 }],
      recordedAt: Game.time,
      outcome: "started_unknown",
      settlement: "quarantined",
    } as never);
    expect(loadProbe.status).toBe("rejected");
    const health = peekTreasuryQuarantineHealth();
    expect(health.healthy).toBe(false);
    const service = makeService();
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.writeAdmission.ready).toBe(false);
    expect(view.writeAdmission.blockers).toContain("quarantine_unhealthy");
  });

  it("finalized proof 恢复幂等：有 proof 时重复 beginTick 均安全", () => {
    const service = makeService();
    void service;
    const write = writeTreasuryIntentEntry({
      transactionId: "sm_final_proof",
      digest: "0123456789abcdef",
      actionKind: "test.transfer",
      kind: "test.transfer",
      source: "test",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -100 }],
      outcome: "returned_non_ok",
      settlement: "finalized",
      createdAtTick: Game.time,
      updatedAtTick: Game.time,
    });
    expect(write.status).toBe("written");
    // proof 缺失 → 保留。
    Game.time += 1;
    makeService().beginTick();
    expect(readTreasuryIntentEntry("sm_final_proof")).toBeDefined();
    // 补 proof（not-executed tombstone）→ 下次恢复释放；再重复幂等。
    // 【第十四轮】intent 为低层 authority（写入时自动派生 durableIdentityDigest），
    // legacy proof 不释放低层——tombstone 须为 proofLevel="lowlevel" 并绑定
    // 同一 durableIdentityDigest（仅 durable identity，禁止 contract/cohort）。
    const tombWrite = writeTreasuryResolutionTombstone({
      transactionId: "sm_final_proof",
      digest: "0123456789abcdef",
      resolution: "not-executed",
      stage: "final",
      proofLevel: "lowlevel",
      durableIdentityDigest: readTreasuryIntentEntry("sm_final_proof")!.durableIdentityDigest!,
      actionTick: Game.time,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
      source: "test",
    });
    expect(tombWrite.status).not.toBe("rejected");
    Game.time += 1;
    makeService().beginTick();
    expect(readTreasuryIntentEntry("sm_final_proof")).toBeUndefined();
    Game.time += 1;
    makeService().beginTick(); // 幂等：无 entry 无异常
  });
});
