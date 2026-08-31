/**
 * 【第十五轮】operation-count fixture。
 *
 * 覆盖：
 * - inconsistent 双 authority 的 staged recovery 不为单条 transaction 扫描
 *   全部 intent/quarantine store（resolver 只读两条 entry；resolution store
 *   自身迭代恰一次）；
 * - resolving capability gate O(1)：签发路径只做单条 tombstone 读取（resolution
 *   store fullScans 零增长），不扫 resolution store 全表；
 * - store-specific read-back 不额外扫描历史 entry（既有 N 条 store 的正常
 *   写入不触发额外全表扫描）。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest, commitSettledReceipt } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import {
  readTreasuryIntentCounters,
  writeTreasuryIntentEntry,
} from "@/runtime/treasury/intents";
import {
  quarantineTreasuryTransaction,
  readTreasuryQuarantineCounters,
} from "@/runtime/treasury/quarantine";
import {
  readTreasuryResolutionStoreCounters,
  recoverStagedResolutions,
  resetTreasuryResolutionStoreForTest,
  writeTreasuryResolutionTombstone,
} from "@/runtime/treasury/resolutionStore";
import { computeTreasuryDurableIdentityDigest } from "@/runtime/treasury/durableIdentity";
import { TREASURY_LOWLEVEL_SOURCE_RUNTIME } from "@/runtime/treasury/authorityLevel";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import { makeTreasuryTestTransferAdapter, registerTreasuryActionAdapter } from "@/runtime/treasury/actionContracts";
import { installRooms, type RoomSpec } from "@mock/treasury";

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 100_000 }, freeCapacity: 10_000 },
    terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 5_000 },
  },
];

const POSTINGS = [{ roomName: "W1N57", locationKind: "storage" as const, resource: "energy" as const, delta: -500 }];
const FILLER_COUNT = 24;

function makeService(): TreasuryTestService {
  const rooms = installRooms(ROOMS);
  const service = treasuryTestService(createTreasuryService({ getRooms: () => Object.values(rooms) }));
  service.beginTick();
  return treasuryTestService(service);
}

function lowlevelIdentity(transactionId: string, digest: string): string {
  return computeTreasuryDurableIdentityDigest({
    transactionId,
    digest,
    actionKind: "terminal.send",
    postings: POSTINGS.map((leg) => ({ ...leg })),
    source: "test",
    adapterSemanticIdentity: "terminal.send@reconciler-semantics-v1",
  });
}

function seedQuarantine(transactionId: string, digest: string): void {
  expect(
    quarantineTreasuryTransaction({
      transactionId,
      authorityLevel: "lowlevel",
      digest,
      tick: Game.time,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      phase: "executing_at_end_tick",
      deltas: POSTINGS.map((leg) => ({ ...leg })),
      recordedAt: Game.time,
      outcome: "started_unknown",
      settlement: "quarantined",
    }).status,
  ).toBe("written");
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  registerTreasuryActionAdapter({
    ...makeTreasuryTestTransferAdapter(),
    kind: "terminal.send",
    semanticIdentity: "terminal.send@reconciler-semantics-v1",
    reconcile: () => "observed_committed" as const,
  });
});

describe("第十五轮 operation-count", () => {
  it("inconsistent 双 authority 恢复不为单条 transaction 扫描全部 intent/quarantine store", () => {
    // 填充两个 store（各 FILLER_COUNT 条）+ 一对 inconsistent 双 authority。
    for (let index = 0; index < FILLER_COUNT; index += 1) {
      seedQuarantine(`op_q_${index}`, `${index.toString(16).padStart(16, "0")}`);
      const intentWrite = writeTreasuryIntentEntry({
        transactionId: `op_i_${index}`,
        authorityLevel: "lowlevel",
        digest: `${index.toString(16).padStart(16, "0")}`,
        kind: "terminal.send",
        actionKind: "terminal.send",
        source: "test",
        postings: POSTINGS.map((leg) => ({ ...leg })),
        outcome: "not_started",
        settlement: "ready",
        createdAtTick: Game.time,
        updatedAtTick: Game.time,
      });
      expect(intentWrite.status).toBe("written");
    }
    const digest = "0123456789abcdef";
    const identity = lowlevelIdentity("op_target", digest);
    seedQuarantine("op_target", digest);
    // 冲突并存 intent（不同 postings 派生的真实 durable）。
    expect(
      writeTreasuryIntentEntry({
        transactionId: "op_target",
        authorityLevel: "lowlevel",
        digest,
        kind: "terminal.send",
        actionKind: "terminal.send",
        source: "test",
        postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -501 }],
        outcome: "returned_ok",
        settlement: "faulted",
        createdAtTick: Game.time,
        updatedAtTick: Game.time,
      }).status,
    ).toBe("written");
    expect(
      writeTreasuryResolutionTombstone({
        transactionId: "op_target",
        digest,
        resolution: "committed",
        stage: "resolving",
        proofLevel: "lowlevel",
        lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
        durableIdentityDigest: identity,
        actionTick: Game.time,
        settledAtTick: Game.time,
        observationTick: Game.time,
        resolvedAtTick: Game.time,
        reconcilerKind: "terminal.send",
        source: "test",
      }).status,
    ).toBe("written");

    const intentScansBefore = readTreasuryIntentCounters().fullScans;
    const quarantineScansBefore = readTreasuryQuarantineCounters().fullScans;
    const resolutionScansBefore = readTreasuryResolutionStoreCounters().fullScans;
    const report = recoverStagedResolutions();
    expect(report.authorityInconsistent).toBe(1);
    // intent/quarantine store 零新增全表扫描（resolver 只做单条 entry 读取，
    // 经 heap 缓存的已验证 store）；【第十六轮第十三节】resolution store 亦
    // 零新增全表扫描——pending 恢复只遍历索引 ID（O(1) 快路径/索引定位）。
    expect(readTreasuryIntentCounters().fullScans).toBe(intentScansBefore);
    expect(readTreasuryQuarantineCounters().fullScans).toBe(quarantineScansBefore);
    expect(readTreasuryResolutionStoreCounters().fullScans).toBe(resolutionScansBefore);
  });

  it("resolving capability gate O(1)：满表 resolution store 上签发不触发额外扫描", () => {
    const digest = "0123456789abcdef";
    const identity = lowlevelIdentity("op_gate", digest);
    seedQuarantine("op_gate", digest);
    // 直接持久化满载历史 final 形态（写入口禁止直接创建 final committed——
    // 容量 fixture 模拟既有 store），再合法创建目标 resolving tombstone。
    Memory.runtime = Memory.runtime ?? ({} as never);
    const fillerEntries: Record<string, unknown> = {};
    for (let index = 0; index < 255; index += 1) {
      fillerEntries[`r:op_filler_${index}`] = {
        transactionId: `op_filler_${index}`,
        digest: "0123456789abcdef",
        resolution: "committed",
        stage: "final",
        proofLevel: "legacy",
        actionTick: 1,
        settledAtTick: 1,
        observationTick: 1,
        resolvedAtTick: 1,
        reconcilerKind: "terminal.send",
      };
    }
    (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury = {
      ...((Memory.runtime ?? {}) as { treasury?: Record<string, unknown> }).treasury,
      resolutions: {
        version: 5,
        entries: fillerEntries,
        entryCount: 255,
        updatedAt: Game.time,
      },
    };
    resetTreasuryResolutionStoreForTest();
    expect(
      writeTreasuryResolutionTombstone({
        transactionId: "op_gate",
        digest,
        resolution: "committed",
        stage: "resolving",
        proofLevel: "lowlevel",
        lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
        durableIdentityDigest: identity,
        actionTick: Game.time,
        settledAtTick: Game.time,
        observationTick: Game.time,
        resolvedAtTick: Game.time,
        reconcilerKind: "terminal.send",
        source: "test",
      }).status,
    ).toBe("written");
    // 阻断 beginTick 自动完成：同 ID conflicting receipt → refresh blocked →
    // resolving 与 authority 均保留。
    expect(
      commitSettledReceipt("op_gate", Game.time, {
        digest: "9999999999999999",
        durableIdentityDigest: lowlevelIdentity("op_gate:foreign", "9999999999999999"),
      }).status,
    ).toBe("written");

    Game.time += 1;
    const next = makeService();
    next.beginTick();
    // beginTick 后、签发前定格计数：签发路径只做单条 tombstone 读取。
    const scansBefore = readTreasuryResolutionStoreCounters().fullScans;
    const issued = next.issueTreasuryReconciliationCapability({ transactionId: "op_gate", digest });
    // 满表 + resolving：gate 命中（resolution_in_progress），reconciler 未
    // 运行；resolution store 零新增全表扫描（O(1) 单条读取）。
    expect(issued.status).toBe("rejected");
    if (issued.status === "rejected") {
      expect(["resolution_in_progress", "resolution_identity_conflict", "resolution_store_full"]).toContain(issued.reason);
    }
    expect(readTreasuryResolutionStoreCounters().fullScans).toBe(scansBefore);
  });

  it("store-specific read-back 不额外扫描历史 entry（既有 N 条的正常写入）", () => {
    for (let index = 0; index < FILLER_COUNT; index += 1) {
      seedQuarantine(`op_rb_${index}`, `${index.toString(16).padStart(16, "0")}`);
    }
    const scansBefore = readTreasuryQuarantineCounters().fullScans;
    const result = quarantineTreasuryTransaction({
      transactionId: "op_rb_new",
      authorityLevel: "lowlevel",
      digest: "0123456789abcdef",
      tick: Game.time,
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      phase: "executing_at_end_tick",
      deltas: POSTINGS.map((leg) => ({ ...leg })),
      recordedAt: Game.time,
      outcome: "started_unknown",
      settlement: "quarantined",
    });
    expect(result.status).toBe("written");
    // read-back 只验证当前 entry——不做历史 entries 的额外扫描。
    expect(readTreasuryQuarantineCounters().fullScans).toBe(scansBefore);
  });
});
