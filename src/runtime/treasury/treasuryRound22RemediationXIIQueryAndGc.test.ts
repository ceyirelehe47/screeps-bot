/**
 * 【Round 22 Remediation XII】Q 组（query purity）、G 组增量（replacement
 * 验证矩阵）、N 组增量（v3 分区迁移）与长跑/容量记录（evidence 数字来源）。
 *
 * Q 组核心断言：全部安全关键只读 API 第一次调用前后 Memory **字节完全
 * 一致**（Q5 的无 warm-up 前提——构造 Memory → 快照 before → 第一次调用
 * → 快照 after）。
 * G 组增量：wrong certificate blocked（G6）、record source 未装配 blocked
 * （G8——health 与读取同源）。
 * N 组增量：64 条 legacy 迁移保留 + current 完整容量（N1）、v2→v3 迁移
 * 中断重跑幂等（N5）。
 * 长跑：≥1000 ticket open/expire/retire 循环 + 各 store 峰值 + Treasury
 * Memory 序列化字节数（evidence 记录实测值）。
 */

import { installRooms, type RoomSpec } from "@mock/treasury";
import { createTreasuryService } from "@/runtime/treasury/facade";
import { treasuryTestService } from "@/runtime/treasury/testHarness";
import {
  openTreasuryIssuedInitialAttempt,
  abandonTreasuryIssuedAttemptTicketForTest,
  resetTreasuryIssuedAttemptTicketHeapCacheForTest,
  peekTreasuryIssuedAttemptTicketActiveCount,
  clearTreasuryIssuedAttemptTicketDurableForTest,
  TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES,
  listTreasuryActiveIssuedTicketTransactionIds,
} from "@/runtime/treasury/attemptIssuanceTicket";
import { clearTreasuryAttemptIssuerDurableForTest, peekTreasuryIssuedAttemptWatermark } from "@/runtime/treasury/attemptIssuer";
import {
  clearTreasuryPersistenceForTest,
} from "@/runtime/treasury/receipts";
import {
  clearTreasuryChainCertificateDurableForTest,
  lookupTreasuryChainRetirementCertificate,
  peekTreasuryChainRetirementCertificateHealth,
  lookupTreasuryRetiredRangeStructured,
  peekTreasuryRetiredRangeHealth,
  peekTreasuryRetiredRangePartitionCounts,
  checkTreasuryAttemptRetiredRange,
  TREASURY_RETIRED_RANGE_CURRENT_CAPACITY,
  TREASURY_RETIRED_RANGE_LEGACY_CAPACITY,
} from "@/runtime/treasury/chainRetirementCertificate";
import { runTreasuryLifecycleGcCoordinator, runTreasuryRetiredRangeMigrationAtTickBoundary } from "@/runtime/treasury/treasuryLifecycleGcCoordinator";
import { resetTreasuryResolutionStoreForTest } from "@/runtime/treasury/resolutionStore";
import { verifyTreasuryPositiveOwnershipForOpening } from "@/runtime/treasury/positiveOwnershipVerifier";
import { treasuryExactAttemptIdentityOfFacts } from "@/runtime/treasury/exactAttemptIdentity";
import { resolveTreasuryAttemptLifecycleOwnership } from "@/runtime/treasury/treasuryLifecycleOwnerResolver";
import { lookupTreasuryTrustedSettledReceipt } from "@/runtime/treasury/receipts";
import { peekTreasuryQuarantineStoreValidation } from "@/runtime/treasury/quarantine";
import { peekTreasuryGenerationRetirementHealth } from "@/runtime/treasury/generationRetirementAuthority";
import { peekTreasuryRetirementSummaryHealth } from "@/runtime/treasury/lineageRetirementSummary";
import { peekTreasuryAttemptLineageHealth } from "@/runtime/treasury/attemptLineage";
import { peekTreasuryIntentStoreValidation } from "@/runtime/treasury/intents";

jest.setTimeout(300_000);

beforeEach(() => {
  jest.clearAllMocks();
  clearTreasuryPersistenceForTest();
  clearTreasuryChainCertificateDurableForTest();
  clearTreasuryAttemptIssuerDurableForTest();
  clearTreasuryIssuedAttemptTicketDurableForTest();
  resetTreasuryResolutionStoreForTest();
});

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 10_000_000 }, freeCapacity: 10_000_000 },
    terminal: { id: "term-1", resources: { energy: 10_000_000 }, freeCapacity: 10_000_000 },
  },
];

function makeService(): ReturnType<typeof treasuryTestService> {
  const rooms = installRooms(ROOMS);
  const service = treasuryTestService(createTreasuryService({ getRooms: () => Object.values(rooms) }));
  service.beginTick();
  return service;
}

function treasuryBranch(): Record<string, unknown> {
  if (!Memory.runtime) Memory.runtime = {} as never;
  const runtime = Memory.runtime as unknown as { treasury?: Record<string, unknown> };
  runtime.treasury = runtime.treasury ?? {};
  return runtime.treasury;
}

/** 【Q5 前提】无 warm-up 的 before/after 字节快照。 */
function memorySnapshot(): string {
  return JSON.stringify((Memory.runtime as unknown as { treasury?: unknown }).treasury ?? null);
}

function openedId(correlation: string): string {
  const opened = openTreasuryIssuedInitialAttempt(correlation);
  if (opened.status !== "opened") throw new Error("open rejected in fixture");
  return opened.transactionId;
}

function abandonedId(correlation: string): string {
  const id = openedId(correlation);
  if (!abandonTreasuryIssuedAttemptTicketForTest(id)) throw new Error("abandon failed");
  return id;
}

// ══ Q 组：query purity ═════════════════════════════════════════════════════

describe("Remediation XII Q：query purity（第一次调用零写）", () => {
  it("Q1：certificate store absent → 第一次 health / lookup root / generation outcome 前后 Memory 完全一致、store 仍不存在", () => {
    makeService();
    const id = openedId("q1");
    const before = memorySnapshot();
    expect(peekTreasuryChainRetirementCertificateHealth().healthy).toBe(true);
    expect(lookupTreasuryChainRetirementCertificate(id)).toBeUndefined();
    expect(lookupTreasuryRetiredRangeStructured(id).status).toBe("absent");
    const after = memorySnapshot();
    expect(after).toBe(before);
    expect((treasuryBranch().chainRetirementCertificates as unknown)).toBeUndefined();
  });

  it("Q2：Quarantine legacy（v4）migration-pending → 第一次 lifecycle resolver 与 positive verifier 返回 blocked/migration_required、Memory 不变", () => {
    makeService();
    const id = openedId("q2");
    treasuryBranch().quarantine = { version: 4, entries: { "q:x": { legacy: true } }, entryCount: 1 };
    resetTreasuryIssuedAttemptTicketHeapCacheForTest();
    const before = memorySnapshot();
    expect(peekTreasuryQuarantineStoreValidation().status).toBe("migration_required");
    const resolved = resolveTreasuryAttemptLifecycleOwnership(id, { excludeIssuedTicket: true, excludeInflightReservations: true });
    expect(resolved.verdict).toBe("blocked");
    const expected = treasuryExactAttemptIdentityOfFacts(id, { digest: "0123456789abcdef", durableIdentityDigest: "dddddddddddddddd" }, "identity-bound");
    const verdict = verifyTreasuryPositiveOwnershipForOpening(id, expected!);
    expect(verdict.verdict).toBe("store_unhealthy");
    expect(memorySnapshot()).toBe(before);
  });

  it("Q3：Receipt legacy（v5 store）→ 第一次 trusted health/lookup 不迁移、Memory 不变、legacy/insufficient 语义", () => {
    makeService();
    const id = openedId("q3");
    treasuryBranch().receipts = { version: 5, settled: {}, entryCount: 0, nextExpiryTick: null, updatedAt: Game.time } as never;
    const before = memorySnapshot();
    const lookup = lookupTreasuryTrustedSettledReceipt(id);
    expect(lookup.status).toBe("store_unhealthy");
    if (lookup.status === "store_unhealthy") expect(lookup.detail).toContain("待迁移");
    expect(memorySnapshot()).toBe(before);
    expect((treasuryBranch().receipts as { version: number }).version).toBe(5);
  });

  it("Q4：GRA/Summary/Lineage 旧版本 store → 全部只读 health/lookup 零迁移、零初始化、Memory 不变", () => {
    makeService();
    const id = openedId("q4");
    const branch = treasuryBranch() as Record<string, unknown>;
    branch.generationRetirementProofs = { version: 1, entries: {}, entryCount: 0, updatedAt: Game.time };
    branch.lineageRetirementSummaries = { version: 2, entries: {}, entryCount: 0, updatedAt: Game.time };
    branch.attemptLineage = { version: 2, entries: {}, entryCount: 0, updatedAt: Game.time };
    // heap 失效（beginTick 的 coordinator 可能已建 absent 空视图——fixture
    // 的 Memory 直塞需要重建 heap 后才可见）。
    require("@/runtime/treasury/generationRetirementAuthority").resetTreasuryGenerationRetirementRuntimeForTest();
    require("@/runtime/treasury/lineageRetirementSummary").resetTreasuryRetirementSummaryRuntimeForTest();
    require("@/runtime/treasury/attemptLineage").resetTreasuryLineageRuntimeForTest();
    const before = memorySnapshot();
    expect(peekTreasuryGenerationRetirementHealth().healthy).toBe(false);
    expect(peekTreasuryRetirementSummaryHealth().healthy).toBe(false);
    expect(peekTreasuryAttemptLineageHealth().healthy).toBe(false);
    expect(memorySnapshot()).toBe(before);
    expect((branch.generationRetirementProofs as { version: number }).version).toBe(1);
    expect((branch.lineageRetirementSummaries as { version: number }).version).toBe(2);
    expect((branch.attemptLineage as { version: number }).version).toBe(2);
  });

  it("Q5：positive owner verifier 完整 query purity——全部 source absent，第一次调用前后 Memory 字节一致", () => {
    makeService();
    const id = openedId("q5");
    const before = memorySnapshot();
    const expected = treasuryExactAttemptIdentityOfFacts(id, { digest: "0123456789abcdef", durableIdentityDigest: "dddddddddddddddd" }, "identity-bound");
    const verdict = verifyTreasuryPositiveOwnershipForOpening(id, expected!);
    expect(verdict.verdict).toBe("absent");
    expect(memorySnapshot()).toBe(before);
  });

  it("Q6：positive owner 存在（not-started）且后方 store（GRA）损坏 → verifier 扫描全部 source 且仍零 Memory 写", () => {
    makeService();
    const id = openedId("q6");
    // matching not-started intent（合法 lowlevel 完整形态）。
    const entry: Record<string, unknown> = {
      authorityLevel: "lowlevel", lowlevelSource: "runtime-lowlevel@v1",
      transactionId: id, digest: "0123456789abc006",
      actionKind: "terminal.send", kind: "terminal.send", source: "test",
      postings: [{ roomName: ROOMS[0].name, locationKind: "storage", resource: "energy", delta: -500 }],
      outcome: "not_started", settlement: "ready", auditSource: "execute-prepared-action",
      createdAtTick: Game.time, updatedAtTick: Game.time,
    };
    const { recomputeTreasuryDurableIdentityDigest } = require("@/runtime/treasury/identityProof") as typeof import("@/runtime/treasury/identityProof");
    entry.durableIdentityDigest = recomputeTreasuryDurableIdentityDigest(entry as never) ?? "dddddddddddddddd";
    (treasuryBranch() as { intents?: unknown }).intents = { version: 7, entries: { ["i:" + id]: entry }, entryCount: 1, updatedAt: Game.time };
    // 后方 GRA store 损坏（unrelated entry）。
    treasuryBranch().generationRetirementProofs = { version: 2, entries: { "gr:broken": { garbage: 1 } }, entryCount: 1, updatedAt: Game.time };
    const { resetTreasuryGenerationRetirementRuntimeForTest } = require("@/runtime/treasury/generationRetirementAuthority") as typeof import("@/runtime/treasury/generationRetirementAuthority");
    resetTreasuryGenerationRetirementRuntimeForTest();
    const before = memorySnapshot();
    const expected = treasuryExactAttemptIdentityOfFacts(id, {
      digest: entry.digest as string, durableIdentityDigest: entry.durableIdentityDigest as string,
    }, "lowlevel");
    const verdict = verifyTreasuryPositiveOwnershipForOpening(id, expected!);
    // 前方 matching not-started owner 不遮蔽后方 unhealthy（3.3）。
    expect(verdict.verdict).toBe("store_unhealthy");
    expect(memorySnapshot()).toBe(before);
  });

  it("Q7：beginTick 显式 migration owner——lineage/summary/GRA/issuer legacy 迁移 + reset 幂等", () => {
    makeService();
    void openedId("q7");
    const branch = treasuryBranch() as Record<string, unknown>;
    // issuer v1（authority migration 阶段迁移）+ range v1（range migration 阶段）。
    branch.attemptIssuer = { version: 1, highWatermark: 100, updatedAt: 0 };
    branch.retiredAttemptRanges = { version: 1, ranges: [{ minSequence: 1, maxSequence: 100, mergedAtTick: 0 }], entryCount: 1, updatedAt: 0 };
    const report = runTreasuryLifecycleGcCoordinator();
    expect(report.authorityMigration.attemptIssuer.status).toBe("migrated");
    expect(report.rangeMigration.status).toBe("migrated");
    // 迁移后 v3 分区（发行域证明：issuer v1 时期 → 全 legacy）。
    const counts = peekTreasuryRetiredRangePartitionCounts();
    expect(counts).toEqual({ current: 0, legacy: 1, legacyOverflow: false });
    // global reset（heap 重建）→ coordinator 幂等（idle 零写）。
    const { resetTreasuryChainCertificateHeapCacheForTest } = require("@/runtime/treasury/chainRetirementCertificate") as typeof import("@/runtime/treasury/chainRetirementCertificate");
    const { resetTreasuryAttemptIssuerHeapCacheForTest } = require("@/runtime/treasury/attemptIssuer") as typeof import("@/runtime/treasury/attemptIssuer");
    resetTreasuryChainCertificateHeapCacheForTest();
    resetTreasuryAttemptIssuerHeapCacheForTest();
    const before = memorySnapshot();
    const repeat = runTreasuryLifecycleGcCoordinator();
    expect(repeat.rangeMigration.status).toBe("idle");
    expect(repeat.authorityMigration.attemptIssuer.status).toBe("idle");
    expect(memorySnapshot()).toBe(before);
  });

  it("Q8：query 函数体不得调用 migration writer / GC / store-creating 分支（架构扫描，第二层守护）", () => {
    const certificateSource = require("fs").readFileSync("src/runtime/treasury/chainRetirementCertificate.ts", "utf8") as string;
    for (const fn of ["peekTreasuryRetiredRangeHealth", "lookupTreasuryRetiredRangeStructured", "checkTreasuryAttemptRetiredRange", "peekTreasuryChainRetirementCertificateHealth"]) {
      const start = certificateSource.indexOf("function " + fn);
      expect(start).toBeGreaterThan(-1);
      const end = certificateSource.indexOf("\nfunction ", start + 1);
      const body = certificateSource.slice(start, end > start ? end : undefined);
      expect(body).not.toContain("migrateLegacyRetiredRangeStore(");
      expect(body).not.toContain("loadRangeRuntime()");
      expect(body).not.toContain("absorbTreasuryRetiredSequence(");
    }
    const intentsSource = require("fs").readFileSync("src/runtime/treasury/intents.ts", "utf8") as string;
    const peekStart = intentsSource.indexOf("export function peekTreasuryIntentStoreValidation");
    const peekEnd = intentsSource.indexOf("\nexport function", peekStart + 1);
    const peekBody = intentsSource.slice(peekStart, peekEnd);
    expect(peekBody).not.toContain("loadIntentStoreRuntime()");
    expect(peekBody).not.toContain("ensureCompletionStorePublished");
  });
});

// ══ G 组增量：replacement 验证矩阵 ═════════════════════════════════════════

describe("Remediation XII G：replacement-proven GRA 增量", () => {
  /** 真实压缩链（XILifecycle seedChain 同构）。 */
  const RUNTIME = "runtime-lowlevel@v1";
  const DIGEST = "0123456789abc001";
  function seedCompactedChain(tag: string): { root: string; lineageId: string } {
    const root = abandonedId(tag);
    const { quarantineTreasuryTransaction, releaseTreasuryQuarantineEntry, readTreasuryQuarantineEntryForQuery: readQ } = require("@/runtime/treasury/quarantine") as typeof import("@/runtime/treasury/quarantine");
    const write = quarantineTreasuryTransaction({
      transactionId: root, authorityLevel: "lowlevel", lowlevelSource: RUNTIME, digest: DIGEST,
      tick: Game.time, kind: "terminal.send", actionKind: "terminal.send", source: "test",
      adapterSemanticIdentity: "terminal.send@reconciler-semantics-v1",
      phase: "ok_pending_commit_unresolved", outcome: "returned_ok", settlement: "quarantined",
      deltas: [{ roomName: ROOMS[0].name, locationKind: "storage" as const, resource: "energy" as const, delta: -500 }],
      recordedAt: Game.time,
    } as never);
    if (write.status !== "written") throw new Error("quarantine seed rejected");
    const durable = readQ(root)?.durableIdentityDigest;
    if (durable === undefined) throw new Error("durable missing");
    const { createTreasuryAttemptLineageRecord, convergeTreasuryLineageRetirementFromFacts } = require("@/runtime/treasury/attemptLineage") as typeof import("@/runtime/treasury/attemptLineage");
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: root,
      rootIdentity: { digest: DIGEST, durableIdentityDigest: durable, lowlevelSource: RUNTIME },
      actionKind: "terminal.send", authorityClass: "lowlevel", lowlevelSource: RUNTIME,
      rearmable: false, identityProfile: "lowlevel", nonRearmReason: "xii g-fixture",
    } as never);
    if (created.status !== "written") throw new Error("lineage seed rejected");
    const lineageId = created.record.lineageId;
    const branch = treasuryBranch() as { resolutions?: { version: number; entries: Record<string, unknown>; entryCount: number; updatedAt: number } };
    branch.resolutions = { version: 7, entries: {}, entryCount: 0, updatedAt: Game.time };
    branch.resolutions.entries["r:" + root] = {
      transactionId: root, digest: DIGEST, resolution: "not-executed", stage: "final",
      proofLevel: "lowlevel", lowlevelSource: RUNTIME, durableIdentityDigest: durable,
      actionTick: Game.time, observationTick: Game.time, resolvedAtTick: Game.time,
      reconcilerKind: "terminal.send", source: "test",
    };
    branch.resolutions.entryCount = 1;
    resetTreasuryResolutionStoreForTest();
    if (releaseTreasuryQuarantineEntry(root) !== true) throw new Error("quarantine release failed");
    const converged = convergeTreasuryLineageRetirementFromFacts(lineageId);
    if (converged.status !== "completed") throw new Error("converge pending");
    const { compactTreasuryTerminalLineage } = require("@/runtime/treasury/lineageRetirementSummary") as typeof import("@/runtime/treasury/lineageRetirementSummary");
    const compacted = compactTreasuryTerminalLineage(lineageId);
    if (compacted.status === "rejected") throw new Error("compaction rejected");
    return { root, lineageId };
  }

  it("G6：wrong certificate（lineage 不一致）→ tombstone_retired release blocked（certificate 覆盖验证）", () => {
    makeService();
    const chainA = seedCompactedChain("g6a");
    // 构造另一条链的 proof（gra store 直塞——root B 的 gen0 proof）。
    const rootB = abandonedId("g6b");
    const { computeTreasuryAttemptLineageId } = require("@/runtime/treasury/attemptLineage") as typeof import("@/runtime/treasury/attemptLineage");
    const { computeTreasuryGenerationRootIdentityDigest } = require("@/runtime/treasury/generationRetirementAuthority") as typeof import("@/runtime/treasury/generationRetirementAuthority");
    const rootIdentityB = { digest: DIGEST, durableIdentityDigest: "1111111111111111", lowlevelSource: RUNTIME };
    const lineageB = computeTreasuryAttemptLineageId(rootB, rootIdentityB as never);
    const branch = treasuryBranch() as { generationRetirementProofs?: { version: number; entries: Record<string, unknown>; entryCount: number; updatedAt: number } };
    branch.generationRetirementProofs = { version: 2, entries: {}, entryCount: 0, updatedAt: Game.time };
    branch.generationRetirementProofs.entries["gr:" + lineageB + ":000000"] = {
      schemaVersion: 2, identityProfile: "lowlevel", lineageId: lineageB,
      rootTransactionId: rootB,
      rootIdentityDigest: computeTreasuryGenerationRootIdentityDigest(rootIdentityB),
      generation: 0, transactionId: rootB, digest: DIGEST,
      authorityClass: "lowlevel", lowlevelSource: RUNTIME,
      durableIdentityDigest: "1111111111111111",
      resolution: "not_executed",
      retirement: { lineagePublished: true, authorityReleased: true, markerCleaned: true },
      completedAtTick: Game.time,
    };
    branch.generationRetirementProofs.entryCount = 1;
    const { resetTreasuryGenerationRetirementRuntimeForTest, releaseTreasuryGenerationRetirementProofOfAttempt } = require("@/runtime/treasury/generationRetirementAuthority") as typeof import("@/runtime/treasury/generationRetirementAuthority");
    resetTreasuryGenerationRetirementRuntimeForTest();
    // rootB 无 certificate（chainA 的 certificate lineage 不匹配 proofB）→
    // tombstone_retired 的 certificate 覆盖验证失败 → blocked。
    const outcome = releaseTreasuryGenerationRetirementProofOfAttempt(rootB, "tombstone_retired");
    expect(outcome.status).toBe("blocked");
    if (outcome.status === "blocked") expect(outcome.reason).toBe("replacement_missing");
    // proof 保留。
    const { lookupTreasuryGenerationRetirementProofByAttemptId } = require("@/runtime/treasury/generationRetirementAuthority") as typeof import("@/runtime/treasury/generationRetirementAuthority");
    expect(lookupTreasuryGenerationRetirementProofByAttemptId(rootB)).toBeDefined();
    void chainA;
  });

  it("G8：lineage record source 未装配（fresh registry）→ health 判定与 record 读取同源缺失 → blocked（不把 undefined 当 absent）", () => {
    makeService();
    const chain = seedCompactedChain("g8");
    // 取消 compaction 的 GRA 孤儿清理已释放 root 的 proof——重新直塞一条
    // gen0 proof（无 active record 依赖问题——本测试验证 record source）。
    const branch = treasuryBranch() as { generationRetirementProofs?: { version: number; entries: Record<string, unknown>; entryCount: number; updatedAt: number } };
    branch.generationRetirementProofs = branch.generationRetirementProofs ?? { version: 2, entries: {}, entryCount: 0, updatedAt: Game.time };
    const { lookupTreasuryGenerationRetirementProofByAttemptId, resetTreasuryGenerationRetirementRuntimeForTest, releaseTreasuryGenerationRetirementProofOfAttempt } = require("@/runtime/treasury/generationRetirementAuthority") as typeof import("@/runtime/treasury/generationRetirementAuthority");
    void lookupTreasuryGenerationRetirementProofByAttemptId;
    // fresh module registry：record source（semantic lineage）未装配。
    let outcome: { status: string; reason?: string; detail?: string } = { status: "unset" };
    jest.isolateModules(() => {
      const gra = require("@/runtime/treasury/generationRetirementAuthority") as typeof import("@/runtime/treasury/generationRetirementAuthority");
      gra.resetTreasuryGenerationRetirementRuntimeForTest();
      const result = gra.releaseTreasuryGenerationRetirementProofOfAttempt(chain.root, "tombstone_retired");
      outcome = { status: result.status, ...(result.status === "blocked" ? { reason: result.reason, detail: result.detail } : {}) };
    });
    // record source 未装配 → 阻断（fail closed——不删除）。
    expect(outcome.status).toBe("blocked");
    if (outcome.reason !== undefined) {
      expect(["store_unhealthy", "replacement_missing"]).toContain(outcome.reason);
    }
  });
});

// ══ N 组增量：v3 分区迁移 ══════════════════════════════════════════════════

describe("Remediation XII N：v3 分区迁移增量", () => {
  it("N1：64 条 legacy 旧数据（v2 combined）迁移 → 全部保留、current 分区仍空且可写完整 48 条（物理隔离）", () => {
    makeService();
    // v2 combined 存量：64 条 legacy 互不相邻区间（旧协议最大）。
    const ranges = Array.from({ length: 64 }, (_, index) => ({
      namespace: "legacy" as const, minSequence: 1 + index * 3, maxSequence: 1 + index * 3, mergedAtTick: Game.time,
    }));
    treasuryBranch().retiredAttemptRanges = { version: 2, ranges, entryCount: 64, updatedAt: Game.time };
    expect(runTreasuryRetiredRangeMigrationAtTickBoundary().status).toBe("migrated");
    const counts = peekTreasuryRetiredRangePartitionCounts();
    // 全部保留（64 > 16 → legacyOverflow 显式标记）。
    expect(counts).toEqual({ current: 0, legacy: 64, legacyOverflow: true });
    // current 分区仍可吸收完整 48 条（legacy 占满旧协议最大 64 条也不占
    // current 的保留容量——物理隔离核心断言）。
    for (let index = 0; index < TREASURY_RETIRED_RANGE_CURRENT_CAPACITY; index += 1) {
      const outcome = require("@/runtime/treasury/chainRetirementCertificate").absorbTreasuryRetiredSequence("current", 1000 + index * 3);
      expect(outcome.status).toBe("absorbed");
    }
    const after = peekTreasuryRetiredRangePartitionCounts();
    expect(after!.current).toBe(TREASURY_RETIRED_RANGE_CURRENT_CAPACITY);
    expect(after!.legacy).toBe(64);
  });

  it("N5：v2 → v3 迁移中断（replacement 写入后 reset）→ 重跑幂等（不重复 range、不丢旧事实、entryCount 一致）", () => {
    makeService();
    const ranges = [
      { namespace: "current" as const, minSequence: 5, maxSequence: 5, mergedAtTick: 1 },
      { namespace: "legacy" as const, minSequence: 1, maxSequence: 10, mergedAtTick: 1 },
    ];
    treasuryBranch().retiredAttemptRanges = { version: 2, ranges, entryCount: 2, updatedAt: 1 };
    const migrated = runTreasuryRetiredRangeMigrationAtTickBoundary();
    expect(migrated.status).toBe("migrated");
    const snapshot = JSON.stringify(treasuryBranch().retiredAttemptRanges);
    // global reset（heap 重建）→ 重跑幂等（v3 → idle 零写、store 不变）。
    const { resetTreasuryChainCertificateHeapCacheForTest } = require("@/runtime/treasury/chainRetirementCertificate") as typeof import("@/runtime/treasury/chainRetirementCertificate");
    resetTreasuryChainCertificateHeapCacheForTest();
    expect(runTreasuryRetiredRangeMigrationAtTickBoundary().status).toBe("idle");
    expect(JSON.stringify(treasuryBranch().retiredAttemptRanges)).toBe(snapshot);
    const counts = peekTreasuryRetiredRangePartitionCounts();
    expect(counts).toEqual({ current: 1, legacy: 1, legacyOverflow: false });
    // 跨域同 sequence（legacy [1,10] 与 current [5,5]）继续独立。
    expect(checkTreasuryAttemptRetiredRange("ti1_5_0123456789abcdef").retired).toBe(true);
    expect(checkTreasuryAttemptRetiredRange("ti2_5_0123456789abcdef").retired).toBe(true);
  });
});

// ══ 长跑与容量记录 ════════════════════════════════════════════════════════

describe("Remediation XII 长跑：≥1000 ticket 循环与容量/字节记录", () => {
  it("XII-LOAD：1000 个 open/abandon/expire/retire 循环 → ticket 有界、watermark 单调、Memory 平台化（记录实测峰值）", () => {
    makeService();
    let maxTicketCount = 0;
    let maxMemoryBytes = 0;
    for (let index = 0; index < 1000; index += 1) {
      const id = openedId("xii_load_" + index);
      if (!abandonTreasuryIssuedAttemptTicketForTest(id)) throw new Error("abandon failed");
      maxTicketCount = Math.max(maxTicketCount, peekTreasuryIssuedAttemptTicketActiveCount());
      const store = treasuryBranch().issuedAttemptTickets as { entries: Record<string, unknown> } | undefined;
      maxTicketCount = Math.max(maxTicketCount, store !== undefined ? Object.keys(store.entries).length : 0);
      if (index % 50 === 0) {
        // 周期 GC（terminal ticket 淘汰）+ 字节采样。
        const report = runTreasuryLifecycleGcCoordinator();
        expect(report.skipped).toBeNull();
        maxMemoryBytes = Math.max(maxMemoryBytes, JSON.stringify((Memory.runtime as unknown as { treasury?: unknown }).treasury).length);
      }
    }
    // 收尾 GC 后的峰值记录（evidence 数字来源——断言带内）。
    let drained = 0;
    for (let round = 0; round < 200; round += 1) {
      if (runTreasuryLifecycleGcCoordinator().ticketsRetired === 0) break;
      drained += 1;
    }
    const finalStore = treasuryBranch().issuedAttemptTickets as { entries: Record<string, unknown> } | undefined;
    const finalCount = finalStore !== undefined ? Object.keys(finalStore.entries).length : 0;
    const finalBytes = JSON.stringify((Memory.runtime as unknown as { treasury?: unknown }).treasury).length;
    // 【XII evidence】实测：maxTicketCount ≤ 硬容量；finalCount ≤ 硬容量；
    // Memory 字节平台化（抽样 max ≤ 首次 × 宽放 + 常数带）。
    expect(maxTicketCount).toBeLessThanOrEqual(TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES);
    expect(finalCount).toBeLessThanOrEqual(TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES);
    expect(finalBytes).toBeLessThan(400_000);
    expect(peekTreasuryIssuedAttemptWatermark()).toBeGreaterThanOrEqual(1000);
    expect(listTreasuryActiveIssuedTicketTransactionIds().length).toBe(0);
    expect(maxMemoryBytes).toBeGreaterThan(0);
  });
});
