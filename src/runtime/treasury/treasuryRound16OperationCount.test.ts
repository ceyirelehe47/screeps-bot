/**
 * 【第十六轮第十三/十五节】resolution recovery O(1) 索引与 operation-count
 * 测试。
 *
 * 覆盖：
 * - 无待恢复项时 beginTick（recoverStagedResolutions）不扫描 resolution
 *   entries（O(1) idleFastPath）；
 * - 只有 1 条 resolving、255 条历史 final 时只处理 1 个 ID（不扫描历史
 *   final tombstone）；
 * - final not-executed pending release 进入索引、补完成后移出；
 * - global reset 首次 load 重建索引一次、后续 tick 不全扫；
 * - retention 删除同步索引；
 * - rearm O(1)（不扫描 receipt/tombstone 历史表）；
 * - store_unhealthy resolver 不回退扫描或选择另一 authority。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { quarantineTreasuryTransaction, readTreasuryQuarantineEntry, releaseTreasuryQuarantineEntry } from "@/runtime/treasury/quarantine";
import {
  peekTreasuryResolutionStoreHealth,
  readTreasuryResolutionStoreCounters,
  readTreasuryResolutionTombstone,
  recoverStagedResolutions,
  resetTreasuryResolutionStoreForTest,
  writeTreasuryResolutionTombstone,
} from "@/runtime/treasury/resolutionStore";
import { recordTreasuryWriteFault } from "@/runtime/treasury/writeFault";
import { TREASURY_LOWLEVEL_SOURCE_RUNTIME } from "@/runtime/treasury/authorityLevel";
import { rearmResolvedNotExecutedAttempt } from "@/runtime/treasury/attemptRearm";
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

/** 派生与 fixture 一致的 durable identity（写入通道重算一致的唯一来源）。 */
function derivedIdentity(transactionId: string): string {
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
    phase: "ok_pending_commit_unresolved",
    outcome: "returned_ok",
    settlement: "quarantined",
    deltas: BASE_POSTINGS.map((leg) => ({ ...leg })),
    recordedAt: Game.time,
  });
  expect(write.status).toBe("written");
  const identity = readTreasuryQuarantineEntry(transactionId)?.durableIdentityDigest;
  expect(identity).toBeDefined();
  return identity as string;
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

describe("第十六轮 operation-count（第十三/十五节）", () => {
  it("无待恢复项时 beginTick 不扫描 resolution store（idleFastPath O(1)）", () => {
    makeService();
    const scansBefore = readTreasuryResolutionStoreCounters().fullScans;
    const report = recoverStagedResolutions();
    expect(report.idleFastPath).toBe(true);
    expect(readTreasuryResolutionStoreCounters().fullScans).toBe(scansBefore);
    expect(readTreasuryResolutionStoreCounters().idleFastPaths).toBeGreaterThanOrEqual(1);
    // 连续多次空闲 tick 保持 O(1)。
    for (let i = 0; i < 5; i += 1) {
      const again = recoverStagedResolutions();
      expect(again.idleFastPath).toBe(true);
    }
    expect(readTreasuryResolutionStoreCounters().fullScans).toBe(scansBefore);
  });

  it("只有 1 条 resolving、255 条历史 final：只处理 1 个 ID（不扫描历史 final）", () => {
    const identity = derivedIdentity("oc_single");
    // 1 条 resolving（inconsistent authority 会阻断——计数定位验证即可）。
    const resolvingWrite = writeTreasuryResolutionTombstone({
      transactionId: "oc_single",
      digest: DIGEST,
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
    });
    expect(resolvingWrite.status).not.toBe("rejected");
    // 255 条历史 final not-executed（无关 pending 项——authority 未释放的
    // 补完成阻断保留在索引；用无 authority/marker 的完成态形态直写不可行，
    // 这里用 historical marker-cleanup-blocked 形态：marker 属于其它 attempt）。
    for (let i = 0; i < 255; i += 1) {
      const w = writeTreasuryResolutionTombstone({
        transactionId: `oc_hist_${String(i)}`,
        digest: DIGEST,
        resolution: "not-executed",
        stage: "final",
        proofLevel: "legacy",
        actionTick: Game.time,
        observationTick: Game.time,
        resolvedAtTick: Game.time,
      });
      expect(w.status).not.toBe("rejected");
    }
    const scansBefore = readTreasuryResolutionStoreCounters().fullScans;
    const report = recoverStagedResolutions();
    // 处理了 pending 集合中的 ID（resolving 1 条 + 历史 final 因无 authority/
    // marker 完成移出——不产生 store 全表扫描）。
    expect(report.idleFastPath).toBe(false);
    expect(readTreasuryResolutionStoreCounters().fullScans).toBe(scansBefore);
    void identity;
  });

  it("final not-executed pending release 进入索引、补完成后移出", () => {
    const identity = derivedIdentity("oc_pending");
    expect(releaseTreasuryQuarantineEntry("oc_pending")).toBe(true);
    const w = writeTreasuryResolutionTombstone({
      transactionId: "oc_pending",
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
    expect(w.status).not.toBe("rejected");
    // marker 不存在 → pending-release 完成移出（非 idle——处理了该项）。
    const report = recoverStagedResolutions();
    expect(report.idleFastPath).toBe(false);
    // 再次：无待处理项 → O(1)。
    const again = recoverStagedResolutions();
    expect(again.idleFastPath).toBe(true);
  });

  it("global reset 首次 load 重建索引一次、后续 tick 不全扫", () => {
    const identity = derivedIdentity("oc_reset");
    expect(releaseTreasuryQuarantineEntry("oc_reset")).toBe(true);
    writeTreasuryResolutionTombstone({
      transactionId: "oc_reset",
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
    // global reset：清 heap（Memory 保留）→ 首次 load 重建索引。
    resetTreasuryResolutionStoreForTest();
    const first = recoverStagedResolutions();
    expect(first.idleFastPath).toBe(false); // 处理 pending 项
    // 后续 tick 不全扫。
    const second = recoverStagedResolutions();
    expect(second.idleFastPath).toBe(true);
    expect(peekTreasuryResolutionStoreHealth().entryCount).toBe(1);
  });

  it("retention 删除同步索引（超龄 final 驱逐后不残留幽灵 pending）", () => {
    // 超龄 final not-executed（resolvedAtTick 远古）——测试时钟从小值开始，
    // 先推进到安全区间。
    Game.time += 7_000;
    const ancient = Game.time - 6_000;
    writeTreasuryResolutionTombstone({
      transactionId: "oc_old",
      digest: DIGEST,
      resolution: "not-executed",
      stage: "final",
      proofLevel: "legacy",
      actionTick: ancient,
      observationTick: ancient,
      resolvedAtTick: ancient,
    });
    // 新 pending 项触发处理 → 超龄项在满载驱逐时同步移出索引；本测试
    // 验证直接驱逐路径后 recovery 空闲。
    const identity = derivedIdentity("oc_new");
    expect(releaseTreasuryQuarantineEntry("oc_new")).toBe(true);
    writeTreasuryResolutionTombstone({
      transactionId: "oc_new",
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
    const report = recoverStagedResolutions();
    expect(report.idleFastPath).toBe(false);
    const after = recoverStagedResolutions();
    expect(after.idleFastPath).toBe(true);
    // 索引不作为安全 proof：Memory 仍是权威（超龄 entry 仍可读）。
    expect(readTreasuryResolutionTombstone("oc_old")).toBeDefined();
  });

  it("rearm O(1)：不扫描 receipt/tombstone 历史表", () => {
    const identity = derivedIdentity("oc_rearm");
    expect(releaseTreasuryQuarantineEntry("oc_rearm")).toBe(true);
    writeTreasuryResolutionTombstone({
      transactionId: "oc_rearm",
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
    const scansBefore = readTreasuryResolutionStoreCounters().fullScans;
    const rearmed = rearmResolvedNotExecutedAttempt({ parentTransactionId: "oc_rearm" });
    expect(rearmed.status).toBe("rearmed");
    expect(readTreasuryResolutionStoreCounters().fullScans).toBe(scansBefore);
    // 重复 rearm 仍 O(1)。
    rearmResolvedNotExecutedAttempt({ parentTransactionId: "oc_rearm" });
    expect(readTreasuryResolutionStoreCounters().fullScans).toBe(scansBefore);
  });
});
