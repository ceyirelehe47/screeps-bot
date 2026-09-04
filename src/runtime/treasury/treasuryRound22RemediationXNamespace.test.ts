/**
 * 【Round 22 Remediation X】Namespace-Scoped Anti-Reuse / Health-Complete
 * Lifecycle GC / Exact GRA Replacement 固定反例（N/H/G 组 + 长期压力）。
 */

import { createTreasuryService } from "@/runtime/treasury/facade";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import { installRooms, type RoomSpec } from "@mock/treasury";
import {
  clearTreasuryIssuedAttemptTicketDurableForTest,
  openTreasuryIssuedInitialAttempt,
  abandonTreasuryIssuedAttemptTicketForTest,
} from "@/runtime/treasury/attemptIssuanceTicket";
import {
  clearTreasuryAttemptIssuerDurableForTest,
  resetTreasuryAttemptIssuerHeapCacheForTest,
  peekTreasuryIssuedAttemptWatermark,
  peekTreasuryLegacyIssuedAttemptWatermark,
} from "@/runtime/treasury/attemptIssuer";
import {
  absorbTreasuryRetiredSequence,
  checkTreasuryAttemptRetiredRange,
  clearTreasuryChainCertificateDurableForTest,
  lookupTreasuryRetiredRangeStructured,
  peekTreasuryRetiredRangeHealth,
  resetTreasuryChainCertificateHeapCacheForTest,
  TREASURY_RETIRED_RANGE_MAX_ENTRIES,
} from "@/runtime/treasury/chainRetirementCertificate";
import {
  convergeTreasuryLineageRetirementFromFacts,
  createTreasuryAttemptLineageRecord,
} from "@/runtime/treasury/attemptLineage";
import {
  compactTreasuryTerminalLineage,
  lookupTreasuryRetirementSummaryByRoot,
  verifyTreasurySummaryCertificateReplacement,
  peekTreasuryRetirementSummaryEntryCount,
} from "@/runtime/treasury/lineageRetirementSummary";
import {
  peekTreasuryGenerationRetirementHealth,
  readTreasuryGenerationRetirementProof,
  lookupTreasuryGenerationRetirementProofByAttemptId,
  verifyTreasuryGenerationSummaryReplacement,
  TREASURY_GENERATION_RETIREMENT_MAX_ENTRIES,
} from "@/runtime/treasury/generationRetirementAuthority";
import {
  ensureTreasuryResolutionSlotAvailable,
  resetTreasuryResolutionStoreForTest,
} from "@/runtime/treasury/resolutionStore";
import { resolveTreasuryAttemptLifecycleOwnership } from "@/runtime/treasury/treasuryLifecycleOwnerResolver";
import { recomputeTreasuryDurableIdentityDigest } from "@/runtime/treasury/identityProof";
import {
  clearTreasuryPersistenceForTest,
} from "@/runtime/treasury/receipts";
import {
  clearTreasuryCleanupCompletionDurableForTest,
} from "@/runtime/treasury/cleanupCompletionAuthority";
import {
  clearTreasuryCleanupSupersessionDurableForTest,
} from "@/runtime/treasury/cleanupSupersessionAuthority";
import { clearTreasuryCompletionHeadroomReservationDurableForTest } from "@/runtime/treasury/completionHeadroomReservation";
import { quarantineTreasuryTransaction, readTreasuryQuarantineEntry, releaseTreasuryQuarantineEntry } from "@/runtime/treasury/quarantine";
import { TREASURY_LOWLEVEL_SOURCE_RUNTIME } from "@/runtime/treasury/authorityLevel";
import type { TreasuryTransactionInput } from "@/runtime/treasury/types";

jest.setTimeout(300_000);

const RUNTIME = TREASURY_LOWLEVEL_SOURCE_RUNTIME;
const DIGEST = "0123456789abc001";

beforeEach(() => {
  jest.clearAllMocks();
  clearTreasuryPersistenceForTest();
  clearTreasuryCleanupCompletionDurableForTest();
  clearTreasuryCleanupSupersessionDurableForTest();
  clearTreasuryChainCertificateDurableForTest();
  clearTreasuryAttemptIssuerDurableForTest();
  clearTreasuryIssuedAttemptTicketDurableForTest();
  clearTreasuryCompletionHeadroomReservationDurableForTest();
  resetTreasuryResolutionStoreForTest();
});

// ── 共享 fixture（与 IX 同构）──────────────────────────────────────────────

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 10_000_000 }, freeCapacity: 10_000_000 },
    terminal: { id: "term-1", resources: { energy: 10_000_000 }, freeCapacity: 10_000_000 },
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
    postings: [{ roomName: ROOMS[0].name, locationKind: "storage", resource: "energy", delta }],
  };
}

function abandonedId(correlation: string): string {
  const opened = openTreasuryIssuedInitialAttempt(correlation);
  if (opened.status !== "opened") throw new Error("open rejected in fixture");
  if (!abandonTreasuryIssuedAttemptTicketForTest(opened.transactionId)) throw new Error("abandon failed");
  return opened.transactionId;
}

function seedQuarantineEntry(transactionId: string): string {
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
    deltas: [{ roomName: ROOMS[0].name, locationKind: "storage" as const, resource: "energy" as const, delta: -500 }],
    recordedAt: Game.time,
  } as never);
  if (write.status !== "written") throw new Error("quarantine seed rejected");
  const durable = readTreasuryQuarantineEntry(transactionId)?.durableIdentityDigest;
  if (durable === undefined) throw new Error("durable missing");
  return durable;
}

function seedFinalNotExecutedTombstone(transactionId: string, durable: string): void {
  if (!Memory.runtime) Memory.runtime = {} as never;
  const runtime = Memory.runtime as unknown as { treasury?: Record<string, unknown> };
  runtime.treasury = runtime.treasury ?? {};
  const branch = runtime.treasury as {
    resolutions?: { version: number; entries: Record<string, unknown>; entryCount: number; updatedAt: number };
  };
  if (branch.resolutions === undefined) {
    branch.resolutions = { version: 7, entries: {}, entryCount: 0, updatedAt: Game.time };
  }
  branch.resolutions.entries["r:" + transactionId] = {
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
  };
  branch.resolutions.entryCount = Object.keys(branch.resolutions.entries).length;
  branch.resolutions.updatedAt = Game.time;
}

/** 删除单条 root tombstone（持久层——模拟 retention 退休后的状态）。 */
function dropTombstone(transactionId: string): void {
  const branch = (Memory.runtime as unknown as { treasury?: { resolutions?: { entries: Record<string, unknown>; entryCount: number } } } | undefined)?.treasury;
  if (branch?.resolutions === undefined) return;
  delete branch.resolutions.entries["r:" + transactionId];
  branch.resolutions.entryCount = Object.keys(branch.resolutions.entries).length;
  resetTreasuryResolutionStoreForTest();
}

function seedNonRearmableRoot(transactionId: string): string {
  const durable = seedQuarantineEntry(transactionId);
  const created = createTreasuryAttemptLineageRecord({
    rootTransactionId: transactionId,
    rootIdentity: { digest: DIGEST, durableIdentityDigest: durable, lowlevelSource: RUNTIME },
    actionKind: "terminal.send",
    authorityClass: "lowlevel",
    lowlevelSource: RUNTIME,
    rearmable: false,
    identityProfile: "lowlevel",
    nonRearmReason: "x fixture",
  });
  if (created.status !== "written") throw new Error("lineage seed rejected");
  const lineageId = created.record.lineageId;
  seedFinalNotExecutedTombstone(transactionId, durable);
  if (releaseTreasuryQuarantineEntry(transactionId) !== true) throw new Error("quarantine release failed");
  const converged = convergeTreasuryLineageRetirementFromFacts(lineageId);
  if (converged.status !== "completed") throw new Error("fixture converge pending: " + JSON.stringify(converged).slice(0, 300));
  return lineageId;
}

/** 手写 v1 issuer store（range 迁移证明的输入）。 */
function seedLegacyIssuerStore(highWatermark: number, migratedAtTick?: number): void {
  if (!Memory.runtime) Memory.runtime = {} as never;
  const runtime = Memory.runtime as unknown as { treasury?: Record<string, unknown> };
  runtime.treasury = runtime.treasury ?? {};
  runtime.treasury.attemptIssuer = migratedAtTick === undefined
    ? { version: 1, highWatermark, updatedAt: Game.time }
    : {
        version: 2,
        highWatermark: 3,
        legacy: { version: 1, highWatermark, retiredAtTick: migratedAtTick - 1 },
        migratedAtTick,
        updatedAt: Game.time,
      };
  resetTreasuryAttemptIssuerHeapCacheForTest();
}

/** 手写 v1 retired range store（迁移源）。 */
function seedV1RetiredRangeStore(minSequence: number, maxSequence: number, updatedAtTick?: number): void {
  if (!Memory.runtime) Memory.runtime = {} as never;
  const runtime = Memory.runtime as unknown as { treasury?: Record<string, unknown> };
  runtime.treasury = runtime.treasury ?? {};
  runtime.treasury.retiredAttemptRanges = {
    version: 1,
    ranges: [{ minSequence, maxSequence, mergedAtTick: updatedAtTick ?? Game.time }],
    entryCount: 1,
    updatedAt: updatedAtTick ?? Game.time,
  };
  resetTreasuryChainCertificateHeapCacheForTest();
}

function treasuryBranch(): Record<string, unknown> {
  if (!Memory.runtime) Memory.runtime = {} as never;
  const runtime = Memory.runtime as unknown as { treasury?: Record<string, unknown> };
  runtime.treasury = runtime.treasury ?? {};
  return runtime.treasury;
}

// ══ N 组：Namespace-scoped anti-reuse ═════════════════════════════════════

describe("Remediation X N：namespace-scoped anti-reuse", () => {
  it("N1：v1 range [1,100]（语义属于 ti1_）迁移归 legacy → open ti2_1 不 retired；旧 ti1_1 仍被 range 阻断", () => {
    makeService();
    seedLegacyIssuerStore(100);
    seedV1RetiredRangeStore(1, 100);
    // 触发迁移（health 探测 → load 显式迁移：issuer v1 → 全部归 legacy）。
    expect(peekTreasuryRetiredRangeHealth().healthy).toBe(true);
    const ranges = (treasuryBranch().retiredAttemptRanges as { version: number; ranges: { namespace: string }[] }).ranges;
    expect(ranges[0]!.namespace).toBe("legacy");
    // ti2_1（current 域）不受 legacy 区间影响。
    const id = abandonedId("n1_current");
    void id;
    expect(checkTreasuryAttemptRetiredRange("ti2_1_0123456789abcdef").retired).toBe(false);
    // 旧 ti1_1 仍被 legacy range 阻断。
    expect(checkTreasuryAttemptRetiredRange("ti1_1_0123456789abcdef").retired).toBe(true);
  });

  it("N2：ti2_1 正式退休进 current range → 不得自动把 ti1_1 判 retired", () => {
    makeService();
    seedLegacyIssuerStore(100);
    seedV1RetiredRangeStore(1, 100);
    expect(peekTreasuryRetiredRangeHealth().healthy).toBe(true);
    // ti2_1 退休（current 域吸收）。
    expect(absorbTreasuryRetiredSequence("current", 1).status).toBe("absorbed");
    // ti1_1 仍由 legacy 域独立判定（current 的事实不覆盖 legacy）。
    expect(checkTreasuryAttemptRetiredRange("ti1_1_0123456789abcdef").retired).toBe(true);
    expect(checkTreasuryAttemptRetiredRange("ti2_1_0123456789abcdef").retired).toBe(true);
    // 反向：legacy 已退休 [1,100] 不因 current 新增而解除。
    expect(checkTreasuryAttemptRetiredRange("ti1_50_0123456789abcdef").retired).toBe(true);
  });

  it("N3：同 sequence=7——ti1_7 retired（legacy）与 ti2_7 active（current）独立", () => {
    makeService();
    seedLegacyIssuerStore(100);
    seedV1RetiredRangeStore(7, 7);
    expect(peekTreasuryRetiredRangeHealth().healthy).toBe(true);
    // current 域没有 7 的区间 → ti2_7 未退休（active）。
    expect(checkTreasuryAttemptRetiredRange("ti2_7_0123456789abcdef").retired).toBe(false);
    expect(checkTreasuryAttemptRetiredRange("ti1_7_0123456789abcdef").retired).toBe(true);
    // 结构化查询独立。
    expect(lookupTreasuryRetiredRangeStructured("ti2_7_0123456789abcdef").status).toBe("absent");
    expect(lookupTreasuryRetiredRangeStructured("ti1_7_0123456789abcdef").status).toBe("present");
  });

  it("N4/N10：同 rootSequence 不同 namespace 的 certificate ↔ summary relation → conflict（issuer domain 显式维度）", () => {
    makeService();
    const root = abandonedId("n4_root");
    const lineageId = seedNonRearmableRoot(root);
    if (compactTreasuryTerminalLineage(lineageId).status !== "compacted") throw new Error("compact rejected");
    const summary = lookupTreasuryRetirementSummaryByRoot(root);
    expect(summary).toBeDefined();
    // ti1_ 域的同序号 certificate（伪造域混用——relation 必须拒绝）。
    const parsed = /ti2_(\d+)_/.exec(root)!;
    const legacyRoot = "ti1_" + parsed[1] + "_0123456789abcdef";
    const legacyCertificate = {
      rootSequence: Number.parseInt(parsed[1]!, 10),
      lineageId: summary!.lineageId,
      rootTransactionId: legacyRoot,
      finalAttemptId: summary!.finalAttemptId,
      finalGeneration: summary!.finalGeneration,
      terminalState: summary!.terminalState,
    };
    const error = verifyTreasurySummaryCertificateReplacement(summary!, legacyCertificate);
    expect(error).not.toBeNull();
    // 反向：current root 与 legacy 域 summary（GRA relation 同维度）。
    const proof = readTreasuryGenerationRetirementProof(summary!.lineageId, 0);
    expect(proof).toBeDefined();
    const graError = verifyTreasuryGenerationSummaryReplacement(proof!, { ...summary!, rootTransactionId: legacyRoot });
    expect(graError).not.toBeNull();
  });

  it("N5：current 域 orphan gap coalesce 只读 current watermark/owner graph——legacy gap 不处理", () => {
    makeService();
    seedLegacyIssuerStore(100);
    seedV1RetiredRangeStore(1, 1);
    expect(peekTreasuryRetiredRangeHealth().healthy).toBe(true);
    // current 域：吸收 1 与 5（经 current 吸收——watermark 需覆盖；gap 序号
    // 需超出近期发行安全窗口（≥32）才可被 coalesce abandon）。
    const ids: string[] = [];
    for (let sequence = 1; sequence <= 40; sequence += 1) {
      ids.push(abandonedId("n5_" + sequence));
    }
    expect(absorbTreasuryRetiredSequence("current", 1).status).toBe("absorbed");
    expect(absorbTreasuryRetiredSequence("current", 5).status).toBe("absorbed");
    // legacy gap（[2,4] 间隙在 legacy 域——coalesce 不处理：吸收 legacy 7、9 制造 legacy gap）。
    expect(absorbTreasuryRetiredSequence("legacy", 9).status).toBe("absorbed");
    expect(absorbTreasuryRetiredSequence("legacy", 11).status).toBe("absorbed");
    // 满载压力触发 coalesce：current gap [2,4] 收敛（abandoned 的孤儿序号）。
    // filler 用间隔序号（连续整数会相邻合并成单区间——永不触发满载）。
    for (let index = 0; index < TREASURY_RETIRED_RANGE_MAX_ENTRIES + 8; index += 1) {
      void absorbTreasuryRetiredSequence("current", 100 + index * 3);
    }
    const rangesAfter = (treasuryBranch().retiredAttemptRanges as { ranges: { namespace: string; minSequence: number; maxSequence: number }[] }).ranges;
    const currentRanges = rangesAfter.filter((range) => range.namespace === "current");
    const legacyRanges = rangesAfter.filter((range) => range.namespace === "legacy");
    // current 域 gap 已桥接（1..5 相邻合并或吸收更多）。
    expect(currentRanges.some((range) => range.minSequence <= 2 && range.maxSequence >= 4)).toBe(true);
    // legacy gap [10] 保持未吸收（coalesce 不触碰 legacy 域）。
    expect(legacyRanges.some((range) => range.minSequence === 10)).toBe(false);
  });


  it("N6：v1 range 不可证明（写入横跨 issuer 迁移时刻）→ 迁移 fail closed（forensic，不静默猜测）", () => {
    makeService();
    seedLegacyIssuerStore(100, 10);
    seedV1RetiredRangeStore(1, 100, 20); // updatedAt 20 >= migratedAtTick 10
    const health = peekTreasuryRetiredRangeHealth();
    expect(health.healthy).toBe(false);
    expect(health.detail ?? "").toContain("不可证明");
    // store 未被迁移改写（v1 原样保留——fail closed 不产生半迁移状态）。
    expect((treasuryBranch().retiredAttemptRanges as { version: number }).version).toBe(1);
    // structured 查询不授权任何域的 present/absent 判定。
    expect(lookupTreasuryRetiredRangeStructured("ti1_1_0123456789abcdef").status).toBe("store_unhealthy");
    expect(absorbTreasuryRetiredSequence("current", 1).status).toBe("rejected");
  });

  it("N7：namespace-aware 迁移 global reset 后幂等——不重复吸收、无双 frontier、旧 blocker 保留", () => {
    makeService();
    seedLegacyIssuerStore(100, 10);
    seedV1RetiredRangeStore(1, 100, 5); // updatedAt 5 < migratedAtTick 10 → 严格归 legacy
    expect(peekTreasuryRetiredRangeHealth().healthy).toBe(true);
    const afterFirst = JSON.stringify(treasuryBranch().retiredAttemptRanges);
    expect(checkTreasuryAttemptRetiredRange("ti1_50_0123456789abcdef").retired).toBe(true);
    // global reset（heap 重建）→ 再 load：幂等（v2 不再迁移，区间不变）。
    resetTreasuryChainCertificateHeapCacheForTest();
    expect(peekTreasuryRetiredRangeHealth().healthy).toBe(true);
    expect(JSON.stringify(treasuryBranch().retiredAttemptRanges)).toBe(afterFirst);
    // 旧 blocker 保留。
    expect(checkTreasuryAttemptRetiredRange("ti1_50_0123456789abcdef").retired).toBe(true);
    expect(checkTreasuryAttemptRetiredRange("ti2_50_0123456789abcdef").retired).toBe(false);
  });

  it("N8：range store malformed / unknown version → structured lookup 返回 unhealthy/malformed，不授权 eviction", () => {
    makeService();
    // malformed：区间 min > max。
    treasuryBranch().retiredAttemptRanges = {
      version: 2, ranges: [{ namespace: "current", minSequence: 3, maxSequence: 1, mergedAtTick: Game.time }], entryCount: 1, updatedAt: Game.time,
    };
    resetTreasuryChainCertificateHeapCacheForTest();
    const malformed = lookupTreasuryRetiredRangeStructured("ti2_2_0123456789abcdef");
    expect(malformed.status === "malformed" || malformed.status === "store_unhealthy").toBe(true);
    expect(malformed.status).not.toBe("present");
    // unknown version。
    treasuryBranch().retiredAttemptRanges = { version: 9, ranges: [], entryCount: 0, updatedAt: Game.time };
    resetTreasuryChainCertificateHeapCacheForTest();
    const unhealthy = lookupTreasuryRetiredRangeStructured("ti2_2_0123456789abcdef");
    expect(unhealthy.status).toBe("store_unhealthy");
    expect(absorbTreasuryRetiredSequence("current", 2).status).toBe("rejected");
  });

  it("N9：historical completion 压缩——ti1_ 与 ti2_ 分别进入匹配 domain 的 anti-reuse authority", () => {
    makeService();
    seedLegacyIssuerStore(100);
    seedV1RetiredRangeStore(1, 100);
    expect(peekTreasuryRetiredRangeHealth().healthy).toBe(true);
    // 触发 issuer v1→v2 迁移（v1 下 peekHealth 报 unhealthy——压缩通道
    // issuerHealthy 前置会跳过全部记录）。
    void abandonedId("n9_warm");
    // 超过保留窗口的条数（最近 64 条不压缩——每条 archivedAtTick 递增）。
    const CURRENT_SEQ = 500;
    for (let index = 0; index < 80; index += 1) {
      Game.time += 1;
      seedHistoricalRecord("ti1_" + (index + 1) + "_0123456789abcd" + String(index).padStart(2, "0"));
      seedHistoricalRecord("ti2_" + (CURRENT_SEQ + index) + "_0123456789abcd" + String(index).padStart(2, "0"));
    }
    const { compressTreasuryRetirableHistoricalEntries } = require("@/runtime/treasury/chainRetirementCertificate") as typeof import("@/runtime/treasury/chainRetirementCertificate");
    const compressed = compressTreasuryRetirableHistoricalEntries();
    expect(compressed.retired).toBeGreaterThan(0);
    const ranges = (treasuryBranch().retiredAttemptRanges as { ranges: { namespace: string; minSequence: number; maxSequence: number }[] }).ranges;
    // legacy 域吸收了 ti1_1..（保留窗口外的旧记录）；current 域吸收了
    // ti2_500..（同批）——两域各自持有自己的序号区间。
    expect(ranges.some((range) => range.namespace === "legacy" && range.minSequence <= 1)).toBe(true);
    expect(ranges.some((range) => range.namespace === "current" && range.minSequence <= CURRENT_SEQ && range.maxSequence >= CURRENT_SEQ)).toBe(true);
    expect(ranges.some((range) => range.namespace === "legacy" && range.minSequence <= CURRENT_SEQ && range.maxSequence >= CURRENT_SEQ)).toBe(false);
    expect(ranges.some((range) => range.namespace === "current" && range.minSequence <= 1 && range.maxSequence >= 1)).toBe(false);
  });
});

/** historical completion 记录注入（VIII 同构）。 */
function seedHistoricalRecord(transactionId: string): void {
  const branch = treasuryBranch() as {
    cleanupSupersessions?: { version?: number; entries: Record<string, unknown>; entryCount: number; updatedAt: number };
  };
  const target = branch.cleanupSupersessions ?? { version: 1, entries: {}, entryCount: 0, updatedAt: Game.time };
  target.entries["sa:" + transactionId] = {
    schemaVersion: 1,
    transactionId,
    resolution: "not-executed",
    identity: { digest: DIGEST, identityProfile: "lowlevel", proofClass: "lowlevel", durableIdentityDigest: "abababababababab", lowlevelSource: RUNTIME },
    lineageDisposition: "not_applicable",
    via: "compact-archive",
    archivedAtTick: Game.time,
  };
  target.entryCount = Object.keys(target.entries).length;
  target.updatedAt = Game.time;
  branch.cleanupSupersessions = { version: 1, entries: target.entries, entryCount: target.entryCount, updatedAt: target.updatedAt };
  const { resetTreasuryCleanupSupersessionHeapCacheForTest } = require("@/runtime/treasury/cleanupSupersessionAuthority") as typeof import("@/runtime/treasury/cleanupSupersessionAuthority");
  resetTreasuryCleanupSupersessionHeapCacheForTest();
}



// ══ H 组：Health-complete owner resolution ═════════════════════════════════

describe("Remediation X H：health-complete owner resolution", () => {
  /** 合法 in-flight intent 注入（H1/H2/H6/H7 的 target/unrelated 维度）。 */
  function seedIntentEntry(transactionId: string, overrides?: Record<string, unknown>): void {
    const branch = treasuryBranch() as {
      intents?: { version: number; entries: Record<string, unknown>; entryCount: number; updatedAt: number };
    };
    if (branch.intents === undefined) {
      branch.intents = { version: 6, entries: {}, entryCount: 0, updatedAt: Game.time };
    }
    // 【XI】durableIdentityDigest 必须与持久事实重算一致（假值会使 intent
    // store 在 v7 校验下 fail closed——正向 handoff 判 blocked 而非 owner）。
    const seeded: Record<string, unknown> = {
      authorityLevel: "lowlevel",
      transactionId,
      digest: DIGEST,
      actionKind: "terminal.send",
      kind: "terminal.send",
      source: "test",
      postings: [{ roomName: ROOMS[0].name, locationKind: "storage", resource: "energy", delta: -500 }],
      outcome: "started_unknown",
      settlement: "executing",
      auditSource: "execute-prepared-action",
      lowlevelSource: "runtime-lowlevel@v1",
      createdAtTick: Game.time,
      updatedAtTick: Game.time,
      ...overrides,
    };
    if (seeded.durableIdentityDigest === undefined) {
      seeded.durableIdentityDigest = recomputeTreasuryDurableIdentityDigest(seeded as never) ?? "abababababababab";
    }
    branch.intents.entries["i:" + transactionId] = seeded;
    branch.intents.entryCount = Object.keys(branch.intents.entries).length;
    branch.intents.updatedAt = Game.time;
  }

  function resetIntentHeap(): void {
    const { resetTreasuryIntentRuntimeForTest } = require("@/runtime/treasury/intents") as typeof import("@/runtime/treasury/intents");
    resetTreasuryIntentRuntimeForTest();
  }

  function resetQuarantineHeap(): void {
    const { resetTreasuryQuarantineRuntimeForTest } = require("@/runtime/treasury/quarantine") as typeof import("@/runtime/treasury/quarantine");
    resetTreasuryQuarantineRuntimeForTest();
  }

  it("H1：Intent store 目标 entry 在位 + store version 损坏 → owned + storeUnhealthy", () => {
    makeService();
    const id = abandonedId("h1");
    seedIntentEntry(id);
    const intents = treasuryBranch().intents as { version: unknown };
    intents.version = 999;
    resetIntentHeap();
    const ownership = resolveTreasuryAttemptLifecycleOwnership(id);
    expect(ownership.status).toBe("owned");
    expect(ownership.storeUnhealthy).toBe(true);
  });

  it("H2：目标 entry 健康 + 同 store 的 unrelated entry 损坏 → 仍不得判 unowned", () => {
    makeService();
    const id = abandonedId("h2_target");
    seedIntentEntry(id);
    seedIntentEntry("ti2_999000_1111111122222222", { digest: 42 as never });
    resetIntentHeap();
    const ownership = resolveTreasuryAttemptLifecycleOwnership(id);
    expect(ownership.status).toBe("owned");
    expect(ownership.storeUnhealthy).toBe(true);
  });

  it("H3：Quarantine store 损坏 → owned + storeUnhealthy", () => {
    makeService();
    const id = abandonedId("h3");
    const durable = seedQuarantineEntry(id);
    void durable;
    const branch = treasuryBranch() as { quarantine?: { entryCount: number } };
    branch.quarantine!.entryCount = 99;
    resetQuarantineHeap();
    const ownership = resolveTreasuryAttemptLifecycleOwnership(id);
    expect(ownership.status).toBe("owned");
    expect(ownership.storeUnhealthy).toBe(true);
  });

  it("H4：Ticket store 损坏 → owned + storeUnhealthy", () => {
    makeService();
    const id = abandonedId("h4");
    void id;
    const branch = treasuryBranch() as { issuedAttemptTickets?: { entryCount: number } };
    branch.issuedAttemptTickets!.entryCount = 77;
    const { resetTreasuryIssuedAttemptTicketHeapCacheForTest } = require("@/runtime/treasury/attemptIssuanceTicket") as typeof import("@/runtime/treasury/attemptIssuanceTicket");
    resetTreasuryIssuedAttemptTicketHeapCacheForTest();
    const ownership = resolveTreasuryAttemptLifecycleOwnership(id);
    expect(ownership.status).toBe("owned");
    expect(ownership.storeUnhealthy).toBe(true);
  });

  it("H5：必要 assembly probe 未装配（fresh module registry）→ owned + storeUnhealthy", () => {
    makeService();
    let freshResolver: typeof import("@/runtime/treasury/treasuryLifecycleOwnerResolver") | null = null;
    jest.isolateModules(() => {
      freshResolver = require("@/runtime/treasury/treasuryLifecycleOwnerResolver") as typeof import("@/runtime/treasury/treasuryLifecycleOwnerResolver");
    });
    expect(freshResolver).not.toBeNull();
    const ownership = freshResolver!.resolveTreasuryAttemptLifecycleOwnership("ti2_42_0123456789abcdef");
    expect(ownership.status).toBe("owned");
    expect(ownership.storeUnhealthy).toBe(true);
  });

  it("H6：Intent store 损坏条件下 TTL sweep → 目标 reservation 保留", () => {
    makeService();
    const id = abandonedId("h6");
    const { acquireTreasuryCompletionHeadroomReservation, TREASURY_COMPLETION_RESERVATION_TTL_TICKS } = require("@/runtime/treasury/completionHeadroomReservation") as typeof import("@/runtime/treasury/completionHeadroomReservation");
    const { sweepOrphanTreasuryCompletionReservations } = require("@/runtime/treasury/cleanupCompletionHandoff") as typeof import("@/runtime/treasury/cleanupCompletionHandoff");
    expect(acquireTreasuryCompletionHeadroomReservation({
      transactionId: id, occupancyAfterAcquire: 1, completionHardCapacity: 128,
    }).status).toBe("acquired");
    seedIntentEntry(id);
    const intents = treasuryBranch().intents as { version: unknown };
    intents.version = 999;
    resetIntentHeap();
    Game.time += TREASURY_COMPLETION_RESERVATION_TTL_TICKS + 1;
    const swept = sweepOrphanTreasuryCompletionReservations(new Set());
    expect(swept).toBe(0);
    const { peekTreasuryCompletionHeadroomReservation } = require("@/runtime/treasury/completionHeadroomReservation") as typeof import("@/runtime/treasury/completionHeadroomReservation");
    expect(peekTreasuryCompletionHeadroomReservation(id)).toBeDefined();
  });

  it("H7：owner store 损坏条件下 retired range orphan gap coalesce → 目标 sequence 不被吸收", () => {
    makeService();
    seedLegacyIssuerStore(100);
    seedV1RetiredRangeStore(1, 1);
    expect(peekTreasuryRetiredRangeHealth().healthy).toBe(true);
    for (let sequence = 1; sequence <= 40; sequence += 1) abandonedId("h7_" + sequence);
    expect(absorbTreasuryRetiredSequence("current", 1).status).toBe("absorbed");
    expect(absorbTreasuryRetiredSequence("current", 5).status).toBe("absorbed");
    // 损坏 intent store（gap 中序号的权威不可判定）。
    seedIntentEntry(abandonedId("h7_intent"));
    const intents = treasuryBranch().intents as { version: unknown };
    intents.version = 999;
    resetIntentHeap();
    // 满载压力触发 coalesce：fail closed（gap [2,4] 中任一序号权威不可判定
    // → 全 gap 不收敛 → 吸收 rejected 或不合并）。
    let coalescedGap = false;
    for (let filler = 100; filler < 100 + TREASURY_RETIRED_RANGE_MAX_ENTRIES + 4; filler += 1) {
      if (absorbTreasuryRetiredSequence("current", filler).status === "rejected") break;
      const ranges = (treasuryBranch().retiredAttemptRanges as { ranges: { namespace: string; minSequence: number; maxSequence: number }[] }).ranges;
      if (ranges.some((range) => range.namespace === "current" && range.minSequence <= 2 && range.maxSequence >= 4)) {
        coalescedGap = true;
        break;
      }
    }
    expect(coalescedGap).toBe(false);
  });

  it("H8：全部 source 健康且明确 absent → 才可返回 unowned", () => {
    makeService();
    const id = abandonedId("h8");
    void id;
    const ownership = resolveTreasuryAttemptLifecycleOwnership(id);
    expect(ownership.status).toBe("unowned");
    expect(ownership.storeUnhealthy).toBe(false);
  });

  it("H9：owner resolver / structured range / 查询路径零写（Memory 快照比较）", () => {
    makeService();
    const id = abandonedId("h9");
    seedIntentEntry(id);
    resetIntentHeap();
    // warm-up（heap load 建立后快照）。
    void resolveTreasuryAttemptLifecycleOwnership(id);
    void lookupTreasuryRetiredRangeStructured(id);
    void peekTreasuryRetiredRangeHealth();
    void checkTreasuryAttemptRetiredRange(id); // 触发空 range store 的惰性初始化
    const before = JSON.stringify((Memory.runtime as unknown as { treasury?: unknown }).treasury);
    for (let round = 0; round < 3; round += 1) {
      void resolveTreasuryAttemptLifecycleOwnership(id);
      void lookupTreasuryRetiredRangeStructured(id);
      void peekTreasuryRetiredRangeHealth();
      void checkTreasuryAttemptRetiredRange(id);
    }
    const after = JSON.stringify((Memory.runtime as unknown as { treasury?: unknown }).treasury);
    expect(after).toBe(before);
  });

  it("H10：conflict / insufficient / malformed source 不被归类为普通 absent", () => {
    makeService();
    const id = abandonedId("h10");
    // live completion 在位 + expected identity 不匹配 → lookup verdict
    // conflict（不是 absent——不因字符串比较折叠）。
    const { recordTreasuryCleanupCompletion, lookupTreasuryCleanupCompletion } = require("@/runtime/treasury/cleanupCompletionAuthority") as typeof import("@/runtime/treasury/cleanupCompletionAuthority");
    const written = recordTreasuryCleanupCompletion({
      entry: {
        transactionId: id,
        digest: DIGEST,
        resolution: "not-executed",
        proofClass: "lowlevel",
        identityProfile: "lowlevel",
        durableIdentityDigest: "aaaaaaaaaaaaaaaa",
        lowlevelSource: RUNTIME,
        settlementProofDurable: true,
        markerDischarged: true,
        authorityReleased: true,
        outcomeFinalized: true,
        lineageFinalized: true,
      } as never,
      lineageDisposition: "not_applicable",
      globalWriteAdmissionStillLocked: false,
    });
    expect(written.status).not.toBe("rejected");
    const mismatched = lookupTreasuryCleanupCompletion(id, {
      digest: "dddddddddddddddd",
      durableIdentityDigest: "eeeeeeeeeeeeeeee",
      lowlevelSource: RUNTIME,
    } as never);
    expect(mismatched.verdict).toBe("conflict");
    const ownership = resolveTreasuryAttemptLifecycleOwnership(id);
    expect(ownership.status).toBe("owned");
    // range malformed → structured 非 absent（N8 已断言；resolver 消费视角
    // 复验：malformed 不折叠为 absent）。
    treasuryBranch().retiredAttemptRanges = {
      version: 2, ranges: [{ namespace: "current", minSequence: 3, maxSequence: 1, mergedAtTick: Game.time }], entryCount: 1, updatedAt: Game.time,
    };
    resetTreasuryChainCertificateHeapCacheForTest();
    const malformed = lookupTreasuryRetiredRangeStructured("ti2_2_0123456789abcdef");
    expect(malformed.status === "malformed" || malformed.status === "store_unhealthy").toBe(true);
  });
});


// ══ G 组：Exact GRA replacement ═══════════════════════════════════════════

describe("Remediation X G：exact GRA replacement", () => {
  function seedChain(tag: string): { root: string; lineageId: string } {
    const root = abandonedId(tag);
    const lineageId = seedNonRearmableRoot(root);
    const compacted = compactTreasuryTerminalLineage(lineageId);
    if (compacted.status !== "compacted") throw new Error("compact rejected: " + JSON.stringify(compacted).slice(0, 240));
    return { root, lineageId };
  }

  it("G1-G6：verifyTreasuryGenerationSummaryReplacement 逐维度（root/lineage/terminalState/class/durable/contract/cohort/lowlevel/profile/schema）", () => {
    makeService();
    const chain = seedChain("g_verifier");
    const proof = readTreasuryGenerationRetirementProof(chain.lineageId, 0);
    expect(proof).toBeDefined();
    const summary = lookupTreasuryRetirementSummaryByRoot(chain.root);
    expect(summary).toBeDefined();
    // 基线：真实链路产物 match。
    expect(verifyTreasuryGenerationSummaryReplacement(proof!, summary!)).toBeNull();
    // G1：root transaction ID 不一致（同 lineage 不同 root）。
    const otherRoot = abandonedId("g_verifier_other");
    expect(verifyTreasuryGenerationSummaryReplacement(proof!, { ...summary!, rootTransactionId: otherRoot })).not.toBeNull();
    // G1：lineage 不一致。
    expect(verifyTreasuryGenerationSummaryReplacement(proof!, { ...summary!, lineageId: "0123456789abcdfd" })).not.toBeNull();
    // G2：terminalState 相反（root-only chain_committed 与 not-executed proof 矛盾）。
    expect(verifyTreasuryGenerationSummaryReplacement(proof!, { ...summary!, terminalState: "chain_committed" })).not.toBeNull();
    // G3：proof class 不一致。
    expect(verifyTreasuryGenerationSummaryReplacement(proof!, { ...summary!, authorityClass: "identity-bound" })).not.toBeNull();
    // G4：durable identity 不一致（rootExact.durableIdentityDigest 篡改）。
    expect(
      verifyTreasuryGenerationSummaryReplacement(proof!, {
        ...summary!, rootExact: { ...summary!.rootExact!, durableIdentityDigest: "cccccccccccccccc" },
      }),
    ).not.toBeNull();
    // G5：lowlevel provenance 冲突（rootExact.lowlevelSource 篡改）。
    expect(
      verifyTreasuryGenerationSummaryReplacement(proof!, {
        ...summary!, rootExact: { ...summary!.rootExact!, lowlevelSource: "migrated-lowlevel@v1" },
      }),
    ).not.toBeNull();
    // G6：legacy replay-only schema 不授权。
    expect(verifyTreasuryGenerationSummaryReplacement(proof!, { ...summary!, schemaVersion: 2 })).not.toBeNull();
    // digest 不一致。
    expect(
      verifyTreasuryGenerationSummaryReplacement(proof!, { ...summary!, rootExact: { ...summary!.rootExact!, digest: "dddddddddddddddd" } }),
    ).not.toBeNull();
    // generation 语义：gen>=1 不由 root exact 接管。
    expect(verifyTreasuryGenerationSummaryReplacement({ ...proof!, generation: 1 } as never, summary!)).not.toBeNull();
  });

  it("G7/G10：满载 + 全部 proof 被 tombstone 依赖（无 eligible）→ fail closed、零删除、converge pending", () => {
    const service = makeService();
    // 不触发 tombstone 惰性退休（持久层注入语义——构造"全部 proof 被 live
    // tombstone 依赖"的满载场景；真实退休链路由 X1 压力覆盖）。
    for (let index = 0; index < TREASURY_GENERATION_RETIREMENT_MAX_ENTRIES; index += 1) {
      Game.time += 60;
      seedChain("g7_" + index);
    }
    expect(peekTreasuryGenerationRetirementHealth().entryCount).toBe(TREASURY_GENERATION_RETIREMENT_MAX_ENTRIES);
    // 第 385 条 converge：满载 → 驱逐扫描（全部 proof 的 root tombstone 在位
    // = exact consumer 依赖）→ 无 eligible → fail closed（retirement 保持
    // retiring——converge pending）。
    const overflow = abandonedId("g7_overflow");
    const durable = seedQuarantineEntry(overflow);
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: overflow,
      rootIdentity: { digest: DIGEST, durableIdentityDigest: durable, lowlevelSource: RUNTIME },
      actionKind: "terminal.send",
      authorityClass: "lowlevel",
      lowlevelSource: RUNTIME,
      rearmable: false,
      identityProfile: "lowlevel",
      nonRearmReason: "g7 overflow",
    });
    if (created.status !== "written") throw new Error("lineage seed rejected");
    seedFinalNotExecutedTombstone(overflow, durable);
    if (releaseTreasuryQuarantineEntry(overflow) !== true) throw new Error("quarantine release failed");
    const converged = convergeTreasuryLineageRetirementFromFacts(created.record.lineageId);
    expect(converged.status).toBe("pending");
    // 零删除：entryCount 仍满、全部旧 proof 在位。
    expect(peekTreasuryGenerationRetirementHealth().entryCount).toBe(TREASURY_GENERATION_RETIREMENT_MAX_ENTRIES);
  });

  it("G8/G9/G11/G12：eligible（tombstone 已退 + exact relation match）→ 有界驱逐腾槽；队首 ineligible 不阻塞；read-back 失败恢复全部索引；reset 后幂等", () => {
    const service = makeService();
    const chains: { root: string; lineageId: string }[] = [];
    for (let index = 0; index < TREASURY_GENERATION_RETIREMENT_MAX_ENTRIES; index += 1) {
      Game.time += 60;
      chains.push(seedChain("g8_" + index));
    }
    expect(peekTreasuryGenerationRetirementHealth().entryCount).toBe(TREASURY_GENERATION_RETIREMENT_MAX_ENTRIES);
    // G9 的队首 ineligible：chains[0]（最早，Object.entries 插入序最前）
    // 保持 tombstone 在位；后方 chains[last] 的 root tombstone 持久层删除
    //（模拟 retention 退休——tombstone 退休联动本应释放 proof，此处构造
    // "联动失败后的 eligible 残留"）。
    const eligibleLast = chains[chains.length - 1]!;
    dropTombstone(eligibleLast.root);
    // G12：replacement（summary）写入后、GRA 删除前 global reset——恢复后
    // 驱逐幂等重验（summary 恒在位，relation 重算）。
    const { resetTreasuryGenerationRetirementRuntimeForTest } = require("@/runtime/treasury/generationRetirementAuthority") as typeof import("@/runtime/treasury/generationRetirementAuthority");
    resetTreasuryGenerationRetirementRuntimeForTest();
    expect(lookupTreasuryRetirementSummaryByRoot(eligibleLast.root)).toBeDefined();
    // 第 385 条 converge：满载 → 扫描跳过队首（tombstone 依赖）→ 驱逐后方
    // eligible → 腾槽 → written。
    const overflow = abandonedId("g8_overflow");
    const durable = seedQuarantineEntry(overflow);
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: overflow,
      rootIdentity: { digest: DIGEST, durableIdentityDigest: durable, lowlevelSource: RUNTIME },
      actionKind: "terminal.send",
      authorityClass: "lowlevel",
      lowlevelSource: RUNTIME,
      rearmable: false,
      identityProfile: "lowlevel",
      nonRearmReason: "g8 overflow",
    });
    if (created.status !== "written") throw new Error("lineage seed rejected");
    seedFinalNotExecutedTombstone(overflow, durable);
    if (releaseTreasuryQuarantineEntry(overflow) !== true) throw new Error("quarantine release failed");
    const converged = convergeTreasuryLineageRetirementFromFacts(created.record.lineageId);
    expect(converged.status).toBe("completed");
    expect(peekTreasuryGenerationRetirementHealth().entryCount).toBe(TREASURY_GENERATION_RETIREMENT_MAX_ENTRIES);
    // 被驱逐的是后方 eligible（队首 chains[0] 的 proof 在位）。
    expect(lookupTreasuryGenerationRetirementProofByAttemptId(chains[0]!.root)).toBeDefined();
    expect(lookupTreasuryGenerationRetirementProofByAttemptId(eligibleLast.root)).toBeUndefined();
    // exact authority 不丢：eligible chain 的 summary 仍在位。
    expect(lookupTreasuryRetirementSummaryByRoot(eligibleLast.root)).toBeDefined();
    // G11：read-back 失败恢复全部索引——把 Memory 中的 GRA store 替换为
    // 浅拷贝（heap 持旧引用）→ 驱逐改 heap 对象而 read-back 读 Memory 拷贝
    // → 不一致 → 完整恢复（entries/entryCount/byAttempt/byLineage）。
    const secondEligible = chains[chains.length - 2]!;
    dropTombstone(secondEligible.root);
    const branch = treasuryBranch() as { generationRetirementProofs?: { version: number; entries: Record<string, unknown>; entryCount: number; updatedAt: number } };
    branch.generationRetirementProofs = {
      version: branch.generationRetirementProofs!.version,
      entries: { ...branch.generationRetirementProofs!.entries },
      entryCount: branch.generationRetirementProofs!.entryCount,
      updatedAt: branch.generationRetirementProofs!.updatedAt,
    };
    const entryCountBefore = branch.generationRetirementProofs!.entryCount;
    const overflow2 = abandonedId("g8_overflow2");
    const durable2 = seedQuarantineEntry(overflow2);
    const created2 = createTreasuryAttemptLineageRecord({
      rootTransactionId: overflow2,
      rootIdentity: { digest: DIGEST, durableIdentityDigest: durable2, lowlevelSource: RUNTIME },
      actionKind: "terminal.send",
      authorityClass: "lowlevel",
      lowlevelSource: RUNTIME,
      rearmable: false,
      identityProfile: "lowlevel",
      nonRearmReason: "g8 overflow2",
    });
    if (created2.status !== "written") throw new Error("lineage seed rejected");
    seedFinalNotExecutedTombstone(overflow2, durable2);
    if (releaseTreasuryQuarantineEntry(overflow2) !== true) throw new Error("quarantine release failed");
    const converged2 = convergeTreasuryLineageRetirementFromFacts(created2.record.lineageId);
    expect(converged2.status).toBe("pending"); // 满载驱逐 read-back 失败 → fail closed
    // 恢复完整：entryCount 与被驱逐 proof 全部在位（索引一致）。
    expect(peekTreasuryGenerationRetirementHealth().entryCount).toBe(entryCountBefore);
    expect(lookupTreasuryGenerationRetirementProofByAttemptId(secondEligible.root)).toBeDefined();
  });
});

// ══ 长期压力（任务书第八节）══════════════════════════════════════════════

describe("Remediation X 压力：长期运行与中断恢复", () => {
  /** production opening（与 X 主文件同构——不引入跨测试文件 import）。 */
  function productionOpening(service: TreasuryTestService, openedTransactionId: string): { callbackCount: number; status: string } {
    const {
      buildTreasuryActionContract, executeTreasuryActionContract, registerTreasuryActionAdapter,
      makeTreasuryTestTransferAdapter, sealTreasuryAdapterRegistryForProduction,
      unsealTreasuryAdapterRegistryForTest, clearTreasuryAdapterRegistryForTest,
    } = require("@/runtime/treasury/actionContracts") as typeof import("@/runtime/treasury/actionContracts");
    registerTreasuryActionAdapter(makeTreasuryTestTransferAdapter());
    registerTreasuryActionAdapter({
      ...makeTreasuryTestTransferAdapter(), kind: "terminal.send", semanticIdentity: "terminal.send@reconciler-semantics-v1",
    } as never);
    const built = buildTreasuryActionContract(service, {
      actionKind: "terminal.send",
      transactionId: openedTransactionId,
      args: { fromRoom: ROOMS[0].name, fromLocation: "storage", toRoom: ROOMS[0].name, toLocation: "terminal", resource: "energy", amount: 100, outcome: "ok" } as never,
    });
    if (built.status === "rejected") return { callbackCount: 0, status: "prepare_rejected" };
    const authorization = service.authorizeTreasuryActionContract(built.contract);
    sealTreasuryAdapterRegistryForProduction();
    try {
      if (authorization.status !== "authorized") return { callbackCount: 0, status: "not_authorized" };
      const result = executeTreasuryActionContract(service, { contract: built.contract, authorization: authorization.bundle }) as { status?: string };
      return { callbackCount: result.status === "executed_committed" ? 1 : 0, status: result.status ?? "unknown" };
    } finally {
      unsealTreasuryAdapterRegistryForTest();
      clearTreasuryAdapterRegistryForTest();
    }
  }

  it("X1：≥600 条现代 terminal chain 后——新 production initial attempt 经 ticket opening 执行、store 恒有界、旧 root 非 absent、旧 ID callback=0", () => {
    const service = makeService();
    const roots: string[] = [];
    for (let index = 0; index < 600; index += 1) {
      Game.time += 60;
      if (index % 10 === 0) {
        service.beginTick();
        const slotError = ensureTreasuryResolutionSlotAvailable();
        if (slotError !== null) throw new Error("slot: " + slotError);
      }
      const root = abandonedId("x1_" + index);
      roots.push(root);
      const lineageId = seedNonRearmableRoot(root);
      if (compactTreasuryTerminalLineage(lineageId).status !== "compacted") throw new Error("compact rejected at " + index);
    }
    // store 恒不超硬上限。
    expect(peekTreasuryRetirementSummaryEntryCount()).toBeLessThanOrEqual(128);
    expect(peekTreasuryGenerationRetirementHealth().entryCount).toBeLessThanOrEqual(TREASURY_GENERATION_RETIREMENT_MAX_ENTRIES);
    expect(peekTreasuryRetiredRangeHealth().healthy).toBe(true);
    // 旧 root resolver 均非 absent。
    for (const probe of [roots[0]!, roots[299]!, roots[599]!]) {
      const { resolveTreasuryDurableSettlementAuthority } = require("@/runtime/treasury/historicalSettlementAuthority") as typeof import("@/runtime/treasury/historicalSettlementAuthority");
      expect(resolveTreasuryDurableSettlementAuthority({ transactionId: probe }).status).not.toBe("absent");
    }
    // 同一旧 ID 经 production opening 重放 → callback 恒 0。
    const replay = productionOpening(service, roots[0]!);
    expect(replay.callbackCount).toBe(0);
    // 新 production initial attempt（ticket opening）→ executed committed。
    Game.time += 1;
    service.beginTick();
    const fresh = openTreasuryIssuedInitialAttempt("x1_fresh");
    expect(fresh.status).toBe("opened");
    if (fresh.status === "opened") {
      const executed = productionOpening(service, fresh.transactionId);
      expect(executed.status).toBe("executed_committed");
      expect(executed.callbackCount).toBe(1);
    }
  });

  it("X2：ticket 高吞吐——单 tick 转换量持续 > GC batch、多 tick——Memory 不线性增长", () => {
    makeService();
    const lengths: number[] = [];
    for (let tick = 0; tick < 12; tick += 1) {
      // 单 tick 20 个 open→abandon（转换量 > GC batch 8）。
      for (let index = 0; index < 20; index += 1) {
        const id = abandonedId("x2_" + tick + "_" + index);
        void id;
      }
      runLifecycleGc();
      lengths.push(JSON.stringify((Memory.runtime as unknown as { treasury?: unknown }).treasury).length);
    }
    // 有界平台：后半程不随历史总数线性增长。
    const lateMax = Math.max(...lengths.slice(6));
    const earlyMax = Math.max(...lengths.slice(0, 6));
    expect(lateMax).toBeLessThanOrEqual(earlyMax + earlyMax * 0.15);
    const { TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES } = require("@/runtime/treasury/attemptIssuanceTicket") as typeof import("@/runtime/treasury/attemptIssuanceTicket");
    const entries = Object.keys((treasuryBranch().issuedAttemptTickets as { entries: Record<string, unknown> }).entries).length;
    expect(entries).toBeLessThanOrEqual(TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES);
  });

  function runLifecycleGc(): void {
    const { runTreasuryLifecycleGcCoordinator } = require("@/runtime/treasury/treasuryLifecycleGcCoordinator") as typeof import("@/runtime/treasury/treasuryLifecycleGcCoordinator");
    runTreasuryLifecycleGcCoordinator();
  }

  it("X3：namespace 并存——legacy 与 current range 同时在位、相同 sequence 不交叉污染", () => {
    makeService();
    seedLegacyIssuerStore(100);
    seedV1RetiredRangeStore(1, 100);
    expect(peekTreasuryRetiredRangeHealth().healthy).toBe(true);
    expect(absorbTreasuryRetiredSequence("current", 1).status).toBe("absorbed");
    const ranges = (treasuryBranch().retiredAttemptRanges as { ranges: { namespace: string; minSequence: number; maxSequence: number }[] }).ranges;
    // 两域并存：legacy [1,100] 与 current [1,1]（同序号、独立区间）。
    expect(ranges.some((range) => range.namespace === "legacy" && range.minSequence === 1 && range.maxSequence === 100)).toBe(true);
    expect(ranges.some((range) => range.namespace === "current" && range.minSequence === 1)).toBe(true);
    expect(checkTreasuryAttemptRetiredRange("ti1_1_0123456789abcdef").retired).toBe(true);
    expect(checkTreasuryAttemptRetiredRange("ti2_1_0123456789abcdef").retired).toBe(true);
  });

  it("X4：global reset 五窗口——issuer 迁移后 / active ticket 后 / durable owner 后 / summary 后 GRA 删除前 / range 迁移后", () => {
    const service = makeService();
    // 窗口 1：issuer v1→v2 迁移写入后 reset → 迁移幂等（无双 watermark）。
    seedLegacyIssuerStore(100);
    const { peekTreasuryAttemptIssuerHealth, checkTreasuryServiceIssuedAttemptId } = require("@/runtime/treasury/attemptIssuer") as typeof import("@/runtime/treasury/attemptIssuer");
    // load 触发 v1→v2 迁移（check → loadIssuerRuntime）。
    void checkTreasuryServiceIssuedAttemptId("ti2_1_0123456789abcdef");
    expect(peekTreasuryAttemptIssuerHealth().healthy).toBe(true);
    resetTreasuryAttemptIssuerHeapCacheForTest();
    expect(peekTreasuryAttemptIssuerHealth().healthy).toBe(true);
    expect(peekTreasuryIssuedAttemptWatermark()).toBe(0);
    expect(peekTreasuryLegacyIssuedAttemptWatermark()).toBe(100);
    // 窗口 2：active ticket 写入后 reset → ticket 从 Memory 恢复（active）。
    const active = openTreasuryIssuedInitialAttempt("x4_active");
    expect(active.status).toBe("opened");
    const { resetTreasuryIssuedAttemptTicketHeapCacheForTest } = require("@/runtime/treasury/attemptIssuanceTicket") as typeof import("@/runtime/treasury/attemptIssuanceTicket");
    resetTreasuryIssuedAttemptTicketHeapCacheForTest();
    const { readTreasuryIssuedAttemptTicket } = require("@/runtime/treasury/attemptIssuanceTicket") as typeof import("@/runtime/treasury/attemptIssuanceTicket");
    expect(readTreasuryIssuedAttemptTicket(active.status === "opened" ? active.transactionId : "")?.state).toBe("active");
    // 窗口 3：durable owner 写入后、ticket cleanup 前 reset → 恢复幂等完成
    // handoff（gate 的 durable-owner 分支）、callback 不重复。
    const handoffTarget = openTreasuryIssuedInitialAttempt("x4_handoff");
    expect(handoffTarget.status).toBe("opened");
    const { completeTreasuryIssuedTicketHandoff } = require("@/runtime/treasury/attemptIssuanceHandoff") as typeof import("@/runtime/treasury/attemptIssuanceHandoff");
    if (handoffTarget.status === "opened") {
      const branchIntents = treasuryBranch() as { intents?: { version: number; entries: Record<string, unknown>; entryCount: number; updatedAt: number } };
      if (branchIntents.intents === undefined) branchIntents.intents = { version: 6, entries: {}, entryCount: 0, updatedAt: Game.time };
      // 【XI】durableIdentityDigest 与持久事实重算一致（假值使 intent store
      // fail closed——正向 handoff 判 blocked 而非 exact_owner）。
      const x4Seeded: Record<string, unknown> = {
        authorityLevel: "lowlevel", transactionId: handoffTarget.transactionId, digest: DIGEST,
        actionKind: "terminal.send", kind: "terminal.send", source: "test",
        postings: [{ roomName: ROOMS[0].name, locationKind: "storage", resource: "energy", delta: -500 }],
        outcome: "started_unknown", settlement: "executing", auditSource: "execute-prepared-action",
        lowlevelSource: "runtime-lowlevel@v1",
        createdAtTick: Game.time, updatedAtTick: Game.time,
      };
      x4Seeded.durableIdentityDigest = recomputeTreasuryDurableIdentityDigest(x4Seeded as never) ?? "abababababababab";
      branchIntents.intents.entries["i:" + handoffTarget.transactionId] = x4Seeded;
      branchIntents.intents.entryCount = Object.keys(branchIntents.intents.entries).length;
      resetTreasuryIssuedAttemptTicketHeapCacheForTest();
      expect(completeTreasuryIssuedTicketHandoff(handoffTarget.transactionId).status).toBe("consumed");
      // 幂等：再次完成 → consumed（无重复副作用）。
      expect(completeTreasuryIssuedTicketHandoff(handoffTarget.transactionId).status).toBe("consumed");
      // 窗口验证完成——恢复（删除 in-flight intent，解除全局 write blocker）。
      delete branchIntents.intents.entries["i:" + handoffTarget.transactionId];
      branchIntents.intents.entryCount = Object.keys(branchIntents.intents.entries).length;
      const { resetTreasuryIntentRuntimeForTest } = require("@/runtime/treasury/intents") as typeof import("@/runtime/treasury/intents");
      resetTreasuryIntentRuntimeForTest();
    }
    // 窗口 4：replacement summary 写入后、旧 GRA 删除前 reset → 幂等完成（G12
    // 行为级已覆盖；此处验证 reset 后 summary 与 GRA 均可读、authority 不丢）。
    const chainRoot = abandonedId("x4_chain");
    const chainLineage = seedNonRearmableRoot(chainRoot);
    if (compactTreasuryTerminalLineage(chainLineage).status !== "compacted") throw new Error("compact rejected");
    const { resetTreasuryGenerationRetirementRuntimeForTest } = require("@/runtime/treasury/generationRetirementAuthority") as typeof import("@/runtime/treasury/generationRetirementAuthority");
    resetTreasuryGenerationRetirementRuntimeForTest();
    expect(lookupTreasuryRetirementSummaryByRoot(chainRoot)).toBeDefined();
    expect(readTreasuryGenerationRetirementProof(chainLineage, 0)).toBeDefined();
    // 窗口 5：namespace range migration 写入后 reset → v2 幂等（N7 已单测；
    // 此处与 issuer/ticket 窗口联动复验）。
    seedV1RetiredRangeStore(200, 300, 0);
    resetTreasuryChainCertificateHeapCacheForTest();
    expect(peekTreasuryRetiredRangeHealth().healthy).toBe(true);
    resetTreasuryChainCertificateHeapCacheForTest();
    expect(peekTreasuryRetiredRangeHealth().healthy).toBe(true);
    expect(checkTreasuryAttemptRetiredRange("ti1_250_0123456789abcdef").retired).toBe(true);
    expect(checkTreasuryAttemptRetiredRange("ti2_250_0123456789abcdef").retired).toBe(false);
    void service;
  });
});
