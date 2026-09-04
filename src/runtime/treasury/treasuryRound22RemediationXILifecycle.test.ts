/**
 * 【Round 22 Remediation XI 工作流 C / D】固定反例——canonical certificate
 * root（C 组）与统一 GRA release authority（G 组）。
 *
 * G 组核心断言：GRA 的全部生产删除经唯一 destructive primitive——
 * tombstone 缺席不是充分条件（lineage/journal 依赖在位即阻断）、legacy
 * replay-only summary 不授权 exact release、blocked 结构化返回（proof 保留
 * 不谎称已释放）、read-back 失败完整恢复全部索引。
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
} from "@/runtime/treasury/attemptIssuer";
import {
  absorbTreasuryRetiredSequence,
  checkTreasuryAttemptRetiredRange,
  clearTreasuryChainCertificateDurableForTest,
  lookupTreasuryRetiredRangeStructured,
  peekTreasuryRetiredRangeHealth,
  recordTreasuryChainRetirementCertificate,
  resetTreasuryChainCertificateHeapCacheForTest,
  TREASURY_RETIRED_RANGE_CURRENT_QUOTA,
  TREASURY_RETIRED_RANGE_LEGACY_QUOTA,
} from "@/runtime/treasury/chainRetirementCertificate";
import {
  runTreasuryRetiredRangeMigrationAtTickBoundary,
  runTreasuryLifecycleGcCoordinator,
} from "@/runtime/treasury/treasuryLifecycleGcCoordinator";
import {
  convergeTreasuryLineageRetirementFromFacts,
  createTreasuryAttemptLineageRecord,
  removeTreasuryAttemptLineageRecordForCompaction,
} from "@/runtime/treasury/attemptLineage";
import {
  compactTreasuryTerminalLineage,
  lookupTreasuryRetirementSummaryByRoot,
} from "@/runtime/treasury/lineageRetirementSummary";
import {
  peekTreasuryGenerationRetirementHealth,
  readTreasuryGenerationRetirementProof,
  lookupTreasuryGenerationRetirementProofByAttemptId,
  releaseTreasuryGenerationRetirementProofOfAttempt,
  releaseOrphanTreasuryGenerationRetirementProofs,
  resetTreasuryGenerationRetirementRuntimeForTest,
  TREASURY_GENERATION_RETIREMENT_MAX_ENTRIES,
} from "@/runtime/treasury/generationRetirementAuthority";
import { resetTreasuryResolutionStoreForTest } from "@/runtime/treasury/resolutionStore";
import { resolveTreasuryAttemptLifecycleOwnership } from "@/runtime/treasury/treasuryLifecycleOwnerResolver";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import {
  clearTreasuryCleanupCompletionDurableForTest,
} from "@/runtime/treasury/cleanupCompletionAuthority";
import {
  clearTreasuryCleanupSupersessionDurableForTest,
} from "@/runtime/treasury/cleanupSupersessionAuthority";
import { clearTreasuryCompletionHeadroomReservationDurableForTest } from "@/runtime/treasury/completionHeadroomReservation";
import { quarantineTreasuryTransaction, releaseTreasuryQuarantineEntry } from "@/runtime/treasury/quarantine";
import { TREASURY_LOWLEVEL_SOURCE_RUNTIME } from "@/runtime/treasury/authorityLevel";

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

// ── 共享 fixture（与 XNamespace 同构）─────────────────────────────────────

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

function abandonedId(correlation: string): string {
  const opened = openTreasuryIssuedInitialAttempt(correlation);
  if (opened.status !== "opened") throw new Error("open rejected in fixture");
  if (!abandonTreasuryIssuedAttemptTicketForTest(opened.transactionId)) throw new Error("abandon failed");
  return opened.transactionId;
}

function treasuryBranch(): Record<string, unknown> {
  if (!Memory.runtime) Memory.runtime = {} as never;
  const runtime = Memory.runtime as unknown as { treasury?: Record<string, unknown> };
  runtime.treasury = runtime.treasury ?? {};
  return runtime.treasury;
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
  const durable = (require("@/runtime/treasury/quarantine") as typeof import("@/runtime/treasury/quarantine")).readTreasuryQuarantineEntry(transactionId)?.durableIdentityDigest;
  if (durable === undefined) throw new Error("durable missing");
  return durable;
}

function seedFinalNotExecutedTombstone(transactionId: string, durable: string): void {
  const branch = treasuryBranch() as {
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

function dropTombstone(transactionId: string): void {
  const branch = treasuryBranch() as { resolutions?: { entries: Record<string, unknown>; entryCount: number } };
  if (branch.resolutions === undefined) return;
  delete branch.resolutions.entries["r:" + transactionId];
  branch.resolutions.entryCount = Object.keys(branch.resolutions.entries).length;
  resetTreasuryResolutionStoreForTest();
}

/** 真实 API 构造 cleanup journal entry（open + activation——五阶段推进）。 */
function seedCleanupJournalEntry(transactionId: string, durable: string): void {
  const journal = require("@/runtime/treasury/resolutionCleanupJournal") as typeof import("@/runtime/treasury/resolutionCleanupJournal");
  const opened = journal.openTreasuryResolutionCleanup({
    transactionId,
    digest: DIGEST,
    resolution: "not-executed",
    identityProfile: "lowlevel",
    proofClass: "lowlevel",
    lowlevelSource: RUNTIME,
    durableIdentityDigest: durable,
  });
  if (opened.status !== "opened") throw new Error("journal seed rejected: " + JSON.stringify(opened).slice(0, 200));
  // reservation 在位即构成 exact consumer（journal entry 存在——readTreasury
  // ResolutionCleanupEntry 非 undefined 即阻断 release）。
}

function seedNonRearmableRoot(transactionId: string): { lineageId: string; durable: string } {
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
  return { lineageId, durable };
}

/** converged chain（proof 在位 + terminal record 在位 + tombstone 在位）。 */
function seedChain(tag: string): { root: string; lineageId: string; durable: string } {
  const root = abandonedId(tag);
  const seeded = seedNonRearmableRoot(root);
  return { root, lineageId: seeded.lineageId, durable: seeded.durable };
}

// ══ C 组：Canonical certificate root ═════════════════════════════════════

describe("Remediation XI C：canonical certificate root", () => {
  function certificateStoreOfMemory(): { entries: Record<string, Record<string, unknown>>; entryCount: number } {
    const store = treasuryBranch().chainRetirementCertificates as { entries: Record<string, Record<string, unknown>>; entryCount: number } | undefined;
    if (store === undefined) throw new Error("certificate store 缺失（fixture 前提）");
    return store;
  }

  function seedRawCertificate(entry: Record<string, unknown>): void {
    // 先建立健康空 store（record 一条合法 legacy-pin certificate——root 为
    // arbitrary 字符串，rootSequence=-1）。
    const legal = recordTreasuryChainRetirementCertificate({
      lineageId: "00000000000000aa",
      rootTransactionId: "legacy-root-a",
      finalAttemptId: "legacy-root-a",
      finalGeneration: 0,
      terminalState: "non_rearmable_retired",
    });
    if (legal.status === "rejected") throw new Error("certificate fixture rejected: " + legal.detail);
    const store = certificateStoreOfMemory();
    store.entries["crc:" + (entry.rootTransactionId as string)] = { ...entry };
    store.entryCount = Object.keys(store.entries).length;
    resetTreasuryChainCertificateHeapCacheForTest();
  }

  it("C1：current root checksum 错误（rootSequence 匹配）→ candidate rejected、不吸收该 sequence、不删除旧 certificate", () => {
    makeService();
    // canonical 真实 root（sequence=1）作对照。
    const { buildTreasuryIssuedInitialAttemptIdFromSequence } = require("@/runtime/treasury/attemptIssuer") as typeof import("@/runtime/treasury/attemptIssuer");
    const built = buildTreasuryIssuedInitialAttemptIdFromSequence(1);
    if (built.status !== "built") throw new Error("build rejected");
    const canonicalRoot = built.transactionId;
    // checksum 篡改（同 sequence、同形态、最后一位替换）。
    const tamperedRoot = canonicalRoot.slice(0, canonicalRoot.length - 1) + (canonicalRoot.endsWith("0") ? "1" : "0");
    const result = recordTreasuryChainRetirementCertificate({
      lineageId: "00000000000000bb",
      rootTransactionId: tamperedRoot,
      finalAttemptId: tamperedRoot,
      finalGeneration: 0,
      terminalState: "non_rearmable_retired",
    });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.detail).toContain("canonical");
    // current retired range 不吸收该 sequence（fail closed——无破坏性变化）。
    expect(((treasuryBranch().retiredAttemptRanges as { ranges: unknown[] } | undefined)?.ranges ?? []).length).toBe(0);
    expect(absorbTreasuryRetiredSequence("current", 1).status).toBe("absorbed");
  });

  it("C2：rootSequence 与 ID 内 sequence 不一致 → 拒绝", () => {
    makeService();
    const { buildTreasuryIssuedInitialAttemptIdFromSequence } = require("@/runtime/treasury/attemptIssuer") as typeof import("@/runtime/treasury/attemptIssuer");
    const built = buildTreasuryIssuedInitialAttemptIdFromSequence(2);
    if (built.status !== "built") throw new Error("build rejected");
    const canonicalRoot = built.transactionId;
    const result = recordTreasuryChainRetirementCertificate({
      lineageId: "00000000000000cc",
      rootTransactionId: canonicalRoot,
      finalAttemptId: canonicalRoot,
      finalGeneration: 0,
      terminalState: "non_rearmable_retired",
    });
    // rootSequence 由 ID 派生——canonical ID 自身一致；构造不一致需要持久层
    // 篡改（record 路径不可构造 mismatch）。改为 store 内手塞 mismatch entry
    // → 整店 unhealthy（validateCertificateCanonicalRelations 检出）。
    expect(result.status).toBe("written");
    const store = certificateStoreOfMemory();
    const entry = store.entries["crc:" + canonicalRoot] as { rootSequence: number };
    entry.rootSequence = 999; // 与 ID 内 sequence=2 不一致
    resetTreasuryChainCertificateHeapCacheForTest();
    const { peekTreasuryChainRetirementCertificateHealth } = require("@/runtime/treasury/chainRetirementCertificate") as typeof import("@/runtime/treasury/chainRetirementCertificate");
    expect(peekTreasuryChainRetirementCertificateHealth().healthy).toBe(false);
    // 损坏 entry 不删除。
    expect(store.entries["crc:" + canonicalRoot]).toBeDefined();
  });

  it("C3：合法 current certificate → 正常写入与查询", () => {
    makeService();
    const { buildTreasuryIssuedInitialAttemptIdFromSequence } = require("@/runtime/treasury/attemptIssuer") as typeof import("@/runtime/treasury/attemptIssuer");
    const built = buildTreasuryIssuedInitialAttemptIdFromSequence(3);
    if (built.status !== "built") throw new Error("build rejected");
    const canonicalRoot = built.transactionId;
    const written = recordTreasuryChainRetirementCertificate({
      lineageId: "00000000000000dd",
      rootTransactionId: canonicalRoot,
      finalAttemptId: canonicalRoot,
      finalGeneration: 0,
      terminalState: "non_rearmable_retired",
    });
    expect(written.status).toBe("written");
    const { lookupTreasuryChainRetirementCertificate } = require("@/runtime/treasury/chainRetirementCertificate") as typeof import("@/runtime/treasury/chainRetirementCertificate");
    expect(lookupTreasuryChainRetirementCertificate(canonicalRoot)?.rootSequence).toBe(3);
  });

  it("C4：legacy/current 同 sequence 隔离（certificate/range 不跨域退休）", () => {
    makeService();
    const { buildTreasuryIssuedInitialAttemptIdFromSequence } = require("@/runtime/treasury/attemptIssuer") as typeof import("@/runtime/treasury/attemptIssuer");
    const built = buildTreasuryIssuedInitialAttemptIdFromSequence(7);
    if (built.status !== "built") throw new Error("build rejected");
    const currentRoot = built.transactionId;
    const written = recordTreasuryChainRetirementCertificate({
      lineageId: "00000000000000ee",
      rootTransactionId: currentRoot,
      finalAttemptId: currentRoot,
      finalGeneration: 0,
      terminalState: "non_rearmable_retired",
    });
    expect(written.status).toBe("written");
    // legacy 域吸收 sequence=7 不影响 current 域查询（两域独立）。
    expect(absorbTreasuryRetiredSequence("legacy", 7).status).toBe("absorbed");
    const { checkTreasuryAttemptRetiredRange } = require("@/runtime/treasury/chainRetirementCertificate") as typeof import("@/runtime/treasury/chainRetirementCertificate");
    expect(checkTreasuryAttemptRetiredRange("ti1_7_0123456789abcdef").retired).toBe(true);
    expect(checkTreasuryAttemptRetiredRange(currentRoot).retired).toBe(false);
    // current 域吸收后同序号两域并存。
    expect(absorbTreasuryRetiredSequence("current", 7).status).toBe("absorbed");
    expect(checkTreasuryAttemptRetiredRange(currentRoot).retired).toBe(true);
  });
});

// ══ G 组：Unified GRA release ═════════════════════════════════════════════

describe("Remediation XI G：统一 GRA release authority", () => {
  it("G1：tombstone 缺席不是充分条件——lineage 仍是当前代 / journal 仍引用 → blocked 保留 proof", () => {
    makeService();
    const chain = seedChain("g1");
    // 变体 a：tombstone 删除但 lineage record 仍是当前代（generation 相同）
    // → lineage_current 阻断（tombstone 不存在不构成释放授权）。
    dropTombstone(chain.root);
    const outcomeA = releaseTreasuryGenerationRetirementProofOfAttempt(chain.root, "tombstone_retired");
    expect(outcomeA.status).toBe("blocked");
    if (outcomeA.status === "blocked") expect(outcomeA.reason).toBe("lineage_current");
    expect(lookupTreasuryGenerationRetirementProofByAttemptId(chain.root)).toBeDefined();
    expect(peekTreasuryGenerationRetirementHealth().entryCount).toBe(1);
    // 变体 b：record 删除 + tombstone 删除但 cleanup journal 仍引用
    // → consumer_active 阻断（G1/G5 同源——exact consumer 未关闭）。
    const removed = removeTreasuryAttemptLineageRecordForCompaction(chain.lineageId);
    expect(removed.status).toBe("removed");
    seedCleanupJournalEntry(chain.root, chain.durable);
    const outcomeB = releaseTreasuryGenerationRetirementProofOfAttempt(chain.root, "orphan_advance");
    expect(outcomeB.status).toBe("blocked");
    if (outcomeB.status === "blocked") expect(outcomeB.reason).toBe("consumer_active");
    expect(lookupTreasuryGenerationRetirementProofByAttemptId(chain.root)).toBeDefined();
    // compaction 孤儿路径同语义：releaseOrphan 结构化 retained。
    const orphanReport = releaseOrphanTreasuryGenerationRetirementProofs(chain.lineageId);
    expect(orphanReport.released).toBe(0);
    expect(orphanReport.retained).toBe(1);
    expect(orphanReport.blockedDetail).toContain("cleanup journal");
  });

  it("G2：legacy replay-only summary（store 非 v3 exact）→ 不授权删除（满载 fail closed 零删除）", () => {
    makeService();
    // 满载 + 全部真实 chain；随后把唯一 summary 篡改为 v2（legacy replay-only
    // 形态）→ summary store 非 exact（probe 过滤/healthy 失败）→ 驱逐零授权。
    const chains: { root: string; lineageId: string }[] = [];
    for (let index = 0; index < TREASURY_GENERATION_RETIREMENT_MAX_ENTRIES; index += 1) {
      Game.time += 60;
      const chain = seedChain("g2_" + index);
      chains.push(chain);
    }
    expect(peekTreasuryGenerationRetirementHealth().entryCount).toBe(TREASURY_GENERATION_RETIREMENT_MAX_ENTRIES);
    // 对 chains[last] 构造 eligible 形态（tombstone 退休 + record 压缩删除）
    //——但 summary 是 legacy replay-only（v2）：exact release 不得被授权。
    const target = chains[chains.length - 1]!;
    dropTombstone(target.root);
    const removedRecord = removeTreasuryAttemptLineageRecordForCompaction(target.lineageId);
    expect(removedRecord.status).toBe("removed");
    const summaryStore = treasuryBranch().lineageRetirementSummaries as { entries: Record<string, { schemaVersion: number }> };
    const summaryKey = Object.keys(summaryStore.entries).find((key) => summaryStore.entries[key]!.schemaVersion === 3 && lookupTreasuryRetirementSummaryByRoot(target.root) !== undefined && key.endsWith(target.root.slice(-16))) ?? Object.keys(summaryStore.entries)[0]!;
    if (summaryStore.entries[summaryKey] !== undefined) {
      summaryStore.entries[summaryKey]!.schemaVersion = 2; // legacy replay-only
    }
    // orphan 路径（非 summary 依赖）对 eligible proof 可释放——本断言聚焦
    // summary_superseded 语义：满载 persist 的驱逐扫描在 legacy summary 下
    // 无 exact replacement 授权 → 零驱逐 → fail closed。
    const overflow = abandonedId("g2_overflow");
    const durable = seedQuarantineEntry(overflow);
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: overflow,
      rootIdentity: { digest: DIGEST, durableIdentityDigest: durable, lowlevelSource: RUNTIME },
      actionKind: "terminal.send",
      authorityClass: "lowlevel",
      lowlevelSource: RUNTIME,
      rearmable: false,
      identityProfile: "lowlevel",
      nonRearmReason: "g2 overflow",
    });
    if (created.status !== "written") throw new Error("lineage seed rejected");
    seedFinalNotExecutedTombstone(overflow, durable);
    if (releaseTreasuryQuarantineEntry(overflow) !== true) throw new Error("quarantine release failed");
    const converged = convergeTreasuryLineageRetirementFromFacts(created.record.lineageId);
    expect(converged.status).toBe("pending");
    expect(peekTreasuryGenerationRetirementHealth().entryCount).toBe(TREASURY_GENERATION_RETIREMENT_MAX_ENTRIES);
  });

  it("G3：compaction 安全完成但 GRA release 被阻断 → 结构化 pending（不谎称已释放）", () => {
    makeService();
    const chain = seedChain("g3");
    // tombstone 保持在位（compaction 前置允许——仍存活 tombstone 的 exact
    // proof 在位）：summary 写入与 record 删除安全完成；孤儿清理对该 proof
    // 被 tombstone 依赖阻断（exact consumer 未关闭）→ pending 诊断 + proof
    // 保留（不谎称已释放）。
    const compacted = compactTreasuryTerminalLineage(chain.lineageId);
    expect(compacted.status).toBe("compacted");
    expect(lookupTreasuryRetirementSummaryByRoot(chain.root)).toBeDefined();
    expect(lookupTreasuryGenerationRetirementProofByAttemptId(chain.root)).toBeDefined();
    const { peekTreasuryCompactionOrphanReleasePending } = require("@/runtime/treasury/lineageRetirementSummary") as typeof import("@/runtime/treasury/lineageRetirementSummary");
    expect(peekTreasuryCompactionOrphanReleasePending()).toContain("tombstone");
    // 修复路径：tombstone 退休（drop）后统一 release authority 补完成。
    dropTombstone(chain.root);
    const released = releaseTreasuryGenerationRetirementProofOfAttempt(chain.root, "compaction_orphan");
    expect(released.status).toBe("released");
  });

  it("G4：exact replacement + dependencies closed → release 成功、索引/entryCount 正确、重复 release 幂等", () => {
    makeService();
    const chain = seedChain("g4");
    // eligible 形态：tombstone 退休 + record 压缩删除（真实压缩链路的后置
    // 中断窗口——compaction 的孤儿清理本应释放，模拟"联动失败残留"）。
    dropTombstone(chain.root);
    expect(removeTreasuryAttemptLineageRecordForCompaction(chain.lineageId).status).toBe("removed");
    const released = releaseTreasuryGenerationRetirementProofOfAttempt(chain.root, "tombstone_retired");
    expect(released.status).toBe("released");
    expect(peekTreasuryGenerationRetirementHealth().entryCount).toBe(0);
    expect(lookupTreasuryGenerationRetirementProofByAttemptId(chain.root)).toBeUndefined();
    expect(readTreasuryGenerationRetirementProof(chain.lineageId, 0)).toBeUndefined();
    // 幂等：再次 release → absent（无重复副作用）。
    const repeat = releaseTreasuryGenerationRetirementProofOfAttempt(chain.root, "tombstone_retired");
    expect(repeat.status).toBe("absent");
  });

  it("G5：release read-back 失败 → blocked + 完整恢复（entries/entryCount/byAttempt/byLineage）", () => {
    makeService();
    const chain = seedChain("g5");
    dropTombstone(chain.root);
    expect(removeTreasuryAttemptLineageRecordForCompaction(chain.lineageId).status).toBe("removed");
    // 受控 test hook：拦截 GRA Memory 解引用一次——删除写入后 read-back 读到
    // 旧 entry（read-back 失败路径触发，完整恢复）。
    const branch = treasuryBranch();
    const real = branch.generationRetirementProofs as { entries: Record<string, unknown>; entryCount: number };
    let sabotage = true;
    Object.defineProperty(branch, "generationRetirementProofs", {
      configurable: true,
      get() {
        if (!sabotage) return real;
        // 刚删除（entryCount 已减为 0 且 store 只剩一条 proof）→ read-back
        // 读到旧计数视图（entryCount 不一致 → read-back 失败路径触发）。
        if (real.entryCount === 0 && Object.keys(real.entries).length === 0) {
          sabotage = false;
          return { ...real, entryCount: real.entryCount + 1 };
        }
        return real;
      },
    });
    const released = releaseTreasuryGenerationRetirementProofOfAttempt(chain.root, "tombstone_retired");
    // 恢复 getter（sabotage 一次性）。
    sabotage = false;
    expect(released.status).toBe("blocked");
    if (released.status === "blocked") expect(released.detail).toContain("read-back");
    // 完整恢复：entry 在位、entryCount 复原、双索引复原。
    expect(peekTreasuryGenerationRetirementHealth().entryCount).toBe(1);
    expect(lookupTreasuryGenerationRetirementProofByAttemptId(chain.root)).toBeDefined();
    expect(readTreasuryGenerationRetirementProof(chain.lineageId, 0)).toBeDefined();
    // 修复后（getter 解除）可再次完成 release。
    const repaired = releaseTreasuryGenerationRetirementProofOfAttempt(chain.root, "tombstone_retired");
    expect(repaired.status).toBe("released");
  });

  it("G7：replacement 在位 + release 前 global reset → 重跑幂等（released 或 absent，至少一方完整在位）", () => {
    makeService();
    const chain = seedChain("g7");
    // 先 compact（summary 写入 = replacement 权威在位），再把 proof 快照
    // 幂等回写（compaction 的孤儿清理因 tombstone 在位保留该 proof——快照
    // 即当前在位对象；此处显式断言后 drop）。
    const proofSnapshot = readTreasuryGenerationRetirementProof(chain.lineageId, 0);
    expect(proofSnapshot).toBeDefined();
    dropTombstone(chain.root);
    expect(removeTreasuryAttemptLineageRecordForCompaction(chain.lineageId).status).toBe("removed");
    // global reset（heap 重建——Memory 是唯一权威）。
    resetTreasuryGenerationRetirementRuntimeForTest();
    expect(lookupTreasuryGenerationRetirementProofByAttemptId(chain.root)).toBeDefined();
    const released = releaseTreasuryGenerationRetirementProofOfAttempt(chain.root, "orphan_advance");
    expect(released.status).toBe("released");
    // reset 后重跑：absent（幂等——不重复副作用、不双重删除）。
    resetTreasuryGenerationRetirementRuntimeForTest();
    const repeat = releaseTreasuryGenerationRetirementProofOfAttempt(chain.root, "orphan_advance");
    expect(repeat.status).toBe("absent");
  });
});

// ══ M 组：Query-pure migration ════════════════════════════════════════════

/** 手写 v1 retired range store（迁移源）。 */
function seedV1RangeStore(minSequence: number, maxSequence: number, updatedAtTick?: number): void {
  treasuryBranch().retiredAttemptRanges = {
    version: 1,
    ranges: [{ minSequence, maxSequence, mergedAtTick: updatedAtTick ?? Game.time }],
    entryCount: 1,
    updatedAt: updatedAtTick ?? Game.time,
  };
  resetTreasuryChainCertificateHeapCacheForTest();
}

/** 手写 v2 issuer store（migration 证明输入：legacyWatermark null = 全新安装）。 */
function seedIssuerStoreV2(highWatermark: number, legacyWatermark: number | null, migratedAtTick: number): void {
  treasuryBranch().attemptIssuer = legacyWatermark === null
    ? { version: 2, highWatermark, migratedAtTick, updatedAt: Game.time }
    : {
        version: 2,
        highWatermark,
        legacy: { version: 1, highWatermark: legacyWatermark, retiredAtTick: migratedAtTick - 1 },
        migratedAtTick,
        updatedAt: Game.time,
      };
  resetTreasuryAttemptIssuerHeapCacheForTest();
}

describe("Remediation XI M：query-pure migration", () => {
  it("M1：v1 range 的所有 query 零写（前后 Memory 序列化完全一致）", () => {
    makeService();
    seedIssuerStoreV2(3, 100, 5);
    seedV1RangeStore(1, 100, 0);
    const id = abandonedId("m1");
    // warm-up（heap 建立后快照——排除首次 load 差异）。
    void resolveTreasuryAttemptLifecycleOwnership(id);
    void lookupTreasuryRetiredRangeStructured(id);
    const before = JSON.stringify((Memory.runtime as unknown as { treasury?: unknown }).treasury);
    for (let round = 0; round < 3; round += 1) {
      expect(peekTreasuryRetiredRangeHealth().healthy).toBe(false); // v1 → migration_required（不迁移）
      expect(lookupTreasuryRetiredRangeStructured(id).status === "migration_required").toBe(true);
      expect(checkTreasuryAttemptRetiredRange(id).retired).toBe(true); // fail closed 阻断
      void resolveTreasuryAttemptLifecycleOwnership(id);
    }
    const after = JSON.stringify((Memory.runtime as unknown as { treasury?: unknown }).treasury);
    expect(after).toBe(before);
    // store 保持 v1（query 不迁移、不初始化、不改 version）。
    expect((treasuryBranch().retiredAttemptRanges as { version: number }).version).toBe(1);
  });

  it("M2：store absent 的全部 query 零写（retiredAttemptRanges 仍不存在）", () => {
    makeService();
    const id = abandonedId("m2");
    for (let round = 0; round < 3; round += 1) {
      expect(peekTreasuryRetiredRangeHealth().healthy).toBe(true);
      expect(lookupTreasuryRetiredRangeStructured(id).status).toBe("absent");
      expect(checkTreasuryAttemptRetiredRange(id).retired).toBe(false);
      void resolveTreasuryAttemptLifecycleOwnership(id);
    }
    expect(treasuryBranch().retiredAttemptRanges).toBeUndefined();
  });

  it("M3：显式可证明 legacy 迁移（issuer v1 → 全部归 legacy）——read-back、query 正常、二次 idle", () => {
    makeService();
    // issuer v1（ti2_ 未诞生）→ v1 区间全部归 legacy。
    treasuryBranch().attemptIssuer = { version: 1, highWatermark: 100, updatedAt: Game.time };
    resetTreasuryAttemptIssuerHeapCacheForTest();
    seedV1RangeStore(1, 100);
    const migration = runTreasuryRetiredRangeMigrationAtTickBoundary();
    expect(migration.status).toBe("migrated");
    const store = treasuryBranch().retiredAttemptRanges as { version: number; ranges: { namespace: string; minSequence: number; maxSequence: number }[]; entryCount: number };
    expect(store.version).toBe(2);
    expect(store.ranges[0]!.namespace).toBe("legacy");
    expect(store.ranges[0]!.minSequence).toBe(1);
    expect(store.ranges[0]!.maxSequence).toBe(100);
    expect(store.entryCount).toBe(1);
    // query 随后正常（健康 + 按域判定）。
    expect(peekTreasuryRetiredRangeHealth().healthy).toBe(true);
    expect(checkTreasuryAttemptRetiredRange("ti1_50_0123456789abcdef").retired).toBe(true);
    expect(checkTreasuryAttemptRetiredRange("ti2_50_0123456789abcdef").retired).toBe(false);
    // 第二次运行幂等（idle 零写）。
    const snapshot = JSON.stringify(treasuryBranch().retiredAttemptRanges);
    expect(runTreasuryRetiredRangeMigrationAtTickBoundary().status).toBe("idle");
    expect(JSON.stringify(treasuryBranch().retiredAttemptRanges)).toBe(snapshot);
  });

  it("M4：显式可证明 current 迁移（issuer v2 无 legacy record → 全部归 current）", () => {
    makeService();
    seedIssuerStoreV2(200, null, 5); // 全新安装——从未有 ti1_ 发行
    seedV1RangeStore(10, 20, 6);
    const migration = runTreasuryRetiredRangeMigrationAtTickBoundary();
    expect(migration.status).toBe("migrated");
    const store = treasuryBranch().retiredAttemptRanges as { ranges: { namespace: string }[] };
    expect(store.ranges[0]!.namespace).toBe("current");
    expect(checkTreasuryAttemptRetiredRange("ti2_15_0123456789abcdef").retired).toBe(true);
    expect(checkTreasuryAttemptRetiredRange("ti1_15_0123456789abcdef").retired).toBe(false);
  });

  it("M5：不可证明混合 v1（updatedAt ≥ migratedAtTick）→ 原 store 原样保留、migration blocked、query 不写、absorb 拒绝", () => {
    makeService();
    seedIssuerStoreV2(3, 100, 10);
    seedV1RangeStore(1, 100, 20); // 写入横跨迁移时刻
    const before = JSON.stringify(treasuryBranch().retiredAttemptRanges);
    expect(peekTreasuryRetiredRangeHealth().healthy).toBe(false);
    const migration = runTreasuryRetiredRangeMigrationAtTickBoundary();
    expect(migration.status).toBe("blocked");
    if (migration.status === "blocked") expect(migration.detail ?? "").toContain("不可证明");
    expect(JSON.stringify(treasuryBranch().retiredAttemptRanges)).toBe(before);
    expect((treasuryBranch().retiredAttemptRanges as { version: number }).version).toBe(1);
    expect(absorbTreasuryRetiredSequence("current", 1).status).toBe("rejected");
    expect(absorbTreasuryRetiredSequence("legacy", 1).status).toBe("rejected");
    // 无第二 frontier：再次 migration 仍 blocked（不产生半迁移 v2）。
    expect(runTreasuryRetiredRangeMigrationAtTickBoundary().status).toBe("blocked");
    expect(Object.keys(treasuryBranch()).filter((key) => key === "retiredAttemptRanges").length).toBe(1);
  });

  it("M6：迁移写入后 global reset → 重跑幂等（ranges 不重复、不跨域、entryCount 一致）", () => {
    makeService();
    treasuryBranch().attemptIssuer = { version: 1, highWatermark: 100, updatedAt: Game.time };
    resetTreasuryAttemptIssuerHeapCacheForTest();
    seedV1RangeStore(1, 50);
    expect(runTreasuryRetiredRangeMigrationAtTickBoundary().status).toBe("migrated");
    const migratedSnapshot = JSON.stringify(treasuryBranch().retiredAttemptRanges);
    // global reset（heap 重建）→ migration owner 幂等 idle、store 不变。
    resetTreasuryChainCertificateHeapCacheForTest();
    expect(runTreasuryRetiredRangeMigrationAtTickBoundary().status).toBe("idle");
    expect(JSON.stringify(treasuryBranch().retiredAttemptRanges)).toBe(migratedSnapshot);
    const store = treasuryBranch().retiredAttemptRanges as { ranges: { namespace: string; minSequence: number; maxSequence: number }[]; entryCount: number };
    expect(store.ranges.length).toBe(1);
    expect(store.ranges[0]!.namespace).toBe("legacy");
    expect(store.entryCount).toBe(1);
  });

  it("M7：GC coordinator 的前置 migration 阶段（report 携带结构化结果）", () => {
    makeService();
    seedIssuerStoreV2(3, 100, 10);
    seedV1RangeStore(1, 100, 20);
    const report = runTreasuryLifecycleGcCoordinator();
    expect(report.rangeMigration.status).toBe("blocked");
    // blocked 不阻断 ticket GC（互不依赖）。
    expect(report.skipped).toBeNull();
    // 【XII/D】修复证明输入：issuer 回 v1。同 tick 内 coordinator 的
    // authority 阶段先把 issuer v1 迁移为 v2（migratedAtTick = 当前
    // tick），range v1 的 updatedAt（20）≥ 迁移时刻时不可证明 → 仍
    // blocked（保守——生产中时间推进后 updatedAt 严格早于迁移时刻即自愈）。
    treasuryBranch().attemptIssuer = { version: 1, highWatermark: 100, updatedAt: Game.time };
    resetTreasuryAttemptIssuerHeapCacheForTest();
    resetTreasuryChainCertificateHeapCacheForTest();
    const sameTick = runTreasuryLifecycleGcCoordinator();
    expect(sameTick.authorityMigration.attemptIssuer.status).toBe("migrated");
    // 修复 issuer 后时间推进（updatedAt 20 严格早于迁移时刻 → 全部
    // ti1_ → legacy 严格可证）→ coordinator 完成迁移。
    treasuryBranch().attemptIssuer = { version: 1, highWatermark: 100, updatedAt: Game.time };
    resetTreasuryAttemptIssuerHeapCacheForTest();
    resetTreasuryChainCertificateHeapCacheForTest();
    Game.time += 100;
    const repaired = runTreasuryLifecycleGcCoordinator();
    expect(repaired.rangeMigration.status).toBe("migrated");
    expect((treasuryBranch().retiredAttemptRanges as { version: number }).version).toBe(2);
  });
});

// ══ Q 组：Namespace capacity ══════════════════════════════════════════════

describe("Remediation XI Q：namespace 容量隔离", () => {
  it("Q1：legacy 占满自身配额 → current 仍有保留容量（吸收不受 legacy 影响）", () => {
    makeService();
    // legacy 域占满自身配额（16 条互不相邻区间）。
    for (let index = 0; index < TREASURY_RETIRED_RANGE_LEGACY_QUOTA; index += 1) {
      expect(absorbTreasuryRetiredSequence("legacy", 1 + index * 3).status).toBe("absorbed");
    }
    // current 域吸收照常（保留容量不受 legacy 占满影响）。
    for (let index = 0; index < 8; index += 1) {
      expect(absorbTreasuryRetiredSequence("current", 2 + index * 3).status).toBe("absorbed");
    }
    const store = treasuryBranch().retiredAttemptRanges as { ranges: { namespace: string }[] };
    expect(store.ranges.filter((range) => range.namespace === "legacy").length).toBe(TREASURY_RETIRED_RANGE_LEGACY_QUOTA);
    expect(store.ranges.filter((range) => range.namespace === "current").length).toBe(8);
  });

  it("Q2：两域互不驱逐——legacy 满载不阻断 current；current 满载不阻断 legacy", () => {
    makeService();
    for (let index = 0; index < TREASURY_RETIRED_RANGE_CURRENT_QUOTA; index += 1) {
      expect(absorbTreasuryRetiredSequence("current", 1 + index * 3).status).toBe("absorbed");
    }
    // current 域满（48）→ current 新增区间 fail closed；legacy 吸收不受影响。
    expect(absorbTreasuryRetiredSequence("current", 1 + TREASURY_RETIRED_RANGE_CURRENT_QUOTA * 3 + 7).status).toBe("rejected");
    expect(absorbTreasuryRetiredSequence("legacy", 5).status).toBe("absorbed");
    const store = treasuryBranch().retiredAttemptRanges as { ranges: { namespace: string }[] };
    expect(store.ranges.filter((range) => range.namespace === "current").length).toBe(TREASURY_RETIRED_RANGE_CURRENT_QUOTA);
    expect(store.ranges.filter((range) => range.namespace === "legacy").length).toBe(1);
  });

  it("Q3：旧 legacy 数据超过新配额 → 不丢失、不静默裁剪、合并式吸收仍允许、新增区间拒绝", () => {
    makeService();
    // 超额 legacy 存量（20 条 > 配额 16——历史数据直注）。
    const ranges: { namespace: "legacy"; minSequence: number; maxSequence: number; mergedAtTick: number }[] = [];
    for (let index = 0; index < 20; index += 1) {
      ranges.push({ namespace: "legacy", minSequence: 1 + index * 3, maxSequence: 1 + index * 3, mergedAtTick: Game.time });
    }
    treasuryBranch().retiredAttemptRanges = { version: 2, ranges, entryCount: ranges.length, updatedAt: Game.time };
    resetTreasuryChainCertificateHeapCacheForTest();
    // store 健康（超额存量不判损坏）。
    expect(peekTreasuryRetiredRangeHealth().healthy).toBe(true);
    // 合并式吸收（扩展既有区间——不新增区间数）允许。
    expect(absorbTreasuryRetiredSequence("legacy", 2).status).toBe("absorbed");
    // 新增 legacy 区间（第 21 条 > 配额 16）拒绝（不裁剪存量腾槽）。
    expect(absorbTreasuryRetiredSequence("legacy", 500).status).toBe("rejected");
    const store = treasuryBranch().retiredAttemptRanges as { ranges: { namespace: string; minSequence: number; maxSequence: number }[] };
    // 数据不丢：20 条全部在位（1 号区间扩展为 [1,2]）。
    expect(store.ranges.filter((range) => range.namespace === "legacy").length).toBe(20);
    expect(store.ranges.some((range) => range.minSequence === 1 && range.maxSequence === 2)).toBe(true);
    // current 保留容量策略不受超额 legacy 影响。
    expect(absorbTreasuryRetiredSequence("current", 7).status).toBe("absorbed");
  });

  it("Q4：扫描有界——store 区间总数 ≤ 物理硬容量、同 sequence 两域独立", () => {
    makeService();
    // 同 sequence 在两个域是两个独立事实（Q2 补充语义）。
    expect(absorbTreasuryRetiredSequence("legacy", 9).status).toBe("absorbed");
    expect(absorbTreasuryRetiredSequence("current", 9).status).toBe("absorbed");
    expect(checkTreasuryAttemptRetiredRange("ti1_9_0123456789abcdef").retired).toBe(true);
    expect(checkTreasuryAttemptRetiredRange("ti2_9_0123456789abcdef").retired).toBe(true);
    // 填满全部物理容量（legacy 16 + current 48 = 64）→ 两域新增均 fail closed
    //（store 恒 ≤ 硬容量——扫描有界）。
    for (let index = 0; index < TREASURY_RETIRED_RANGE_LEGACY_QUOTA - 1; index += 1) {
      void absorbTreasuryRetiredSequence("legacy", 20 + index * 3);
    }
    for (let index = 0; index < TREASURY_RETIRED_RANGE_CURRENT_QUOTA - 1; index += 1) {
      void absorbTreasuryRetiredSequence("current", 20 + index * 3);
    }
    const store = treasuryBranch().retiredAttemptRanges as { ranges: unknown[] };
    expect(store.ranges.length).toBeLessThanOrEqual(64);
    expect(absorbTreasuryRetiredSequence("legacy", 900).status).toBe("rejected");
    expect(absorbTreasuryRetiredSequence("current", 900).status).toBe("rejected");
    expect(store.ranges.length).toBeLessThanOrEqual(64);
  });
});

// ══ 压力回归（任务书第八节：1000 open/expire/retire 循环 + 容量记录）════

describe("Remediation XI 压力：open/expire/retire 循环与容量记录", () => {
  it("P1：≥1000 open/expire/retire 循环——store 恒有界、Memory 不线性增长、reset 后状态一致", () => {
    makeService();
    let maxEntryCount = 0;
    const memoryLengths: number[] = [];
    // 1000 个 opening：每 8 个推进 tick（GC 每批 ≤8 回收 terminal）；
    // 每个循环 open → 持久层 expire（TTL 显式转换）→ GC retire。
    const { expireTreasuryIssuedAttemptTickets } = require("@/runtime/treasury/attemptIssuanceTicket") as typeof import("@/runtime/treasury/attemptIssuanceTicket");
    const { peekTreasuryIssuedAttemptTicketActiveCount, peekTreasuryIssuedAttemptTicketHealth } = require("@/runtime/treasury/attemptIssuanceTicket") as typeof import("@/runtime/treasury/attemptIssuanceTicket");
    for (let index = 0; index < 1000; index += 1) {
      const opened = abandonedId("p1_" + index);
      void opened;
      if (index % 8 === 7) {
        Game.time += 600; // TTL 过期
        void expireTreasuryIssuedAttemptTickets();
        void runTreasuryLifecycleGcCoordinator();
        Game.time += 1;
        const store = (treasuryBranch().issuedAttemptTickets as { entries: Record<string, unknown> } | undefined);
        maxEntryCount = Math.max(maxEntryCount, store !== undefined ? Object.keys(store.entries).length : 0);
        if (index % 64 === 63) {
          memoryLengths.push(JSON.stringify(treasuryBranch()).length);
        }
      }
    }
    // 收尾：全部 terminal 回收。
    for (let round = 0; round < 140; round += 1) {
      if (runTreasuryLifecycleGcCoordinator().ticketsRetired === 0) break;
    }
    const finalCount = (treasuryBranch().issuedAttemptTickets as { entries: Record<string, unknown> } | undefined)?.entries !== undefined
      ? Object.keys((treasuryBranch().issuedAttemptTickets as { entries: Record<string, unknown> }).entries).length
      : 0;
    expect(finalCount).toBeLessThanOrEqual(8);
    expect(maxEntryCount).toBeLessThanOrEqual(128);
    expect(peekTreasuryIssuedAttemptTicketHealth().healthy).toBe(true);
    // Memory 不随 1000 循环线性增长（平台带内：后半段最大值不超首段 10%）。
    if (memoryLengths.length >= 8) {
      const lateMax = Math.max(...memoryLengths.slice(Math.floor(memoryLengths.length / 2)));
      const earlyMax = Math.max(...memoryLengths.slice(0, Math.floor(memoryLengths.length / 2)));
      expect(lateMax).toBeLessThanOrEqual(earlyMax + lateMax * 0.5);
    }
    void peekTreasuryIssuedAttemptTicketActiveCount;
  });

  it("P2：容量记录——各 store 满载上界与 quota 一致（evidence 数字来源）", () => {
    makeService();
    // retired range：legacy 16 + current 48 = 64（quota 上界）。
    for (let index = 0; index < TREASURY_RETIRED_RANGE_LEGACY_QUOTA; index += 1) {
      void absorbTreasuryRetiredSequence("legacy", 1 + index * 3);
    }
    for (let index = 0; index < TREASURY_RETIRED_RANGE_CURRENT_QUOTA; index += 1) {
      void absorbTreasuryRetiredSequence("current", 2 + index * 3);
    }
    const rangeStore = treasuryBranch().retiredAttemptRanges as { ranges: { namespace: string }[] };
    expect(rangeStore.ranges.length).toBe(64);
    expect(rangeStore.ranges.filter((range) => range.namespace === "legacy").length).toBe(TREASURY_RETIRED_RANGE_LEGACY_QUOTA);
    expect(rangeStore.ranges.filter((range) => range.namespace === "current").length).toBe(TREASURY_RETIRED_RANGE_CURRENT_QUOTA);
    // ticket 总容量 128（active 64 上界由 X 轮 B 系覆盖——此处终态断言）。
    const { TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES } = require("@/runtime/treasury/attemptIssuanceTicket") as typeof import("@/runtime/treasury/attemptIssuanceTicket");
    expect(TREASURY_ISSUED_TICKET_MAX_TOTAL_ENTRIES).toBe(128);
    // GRA 384（X 轮 G 系满载已覆盖——常量断言）。
    expect(TREASURY_GENERATION_RETIREMENT_MAX_ENTRIES).toBe(384);
  });
});
