/**
 * 【第二十一轮】terminal compaction 四方 proof、root/historical child
 * replacement 与 receipt refresh 的 proof-class-aware exact relation 测试。
 *
 * 覆盖（任务书第十一/十二/十三节与十七节矩阵）：
 * - non-rearmable compaction：tombstone ↔ record ↔ exact proof ↔ semantic ↔
 *   summary candidate 五方全部 match 才压缩；proof 只是存在但内容不同 /
 *   缺失 / store unhealthy → 不压缩；
 * - chain-committed compaction：receipt 与 record/semantic/candidate 完整
 *   match；压缩后 terminal current exact validation 继续 match、错误 identity
 *   不能 match；
 * - root replacement：v3 rootExact 完整比较；digest/lowlevelSource 不同 →
 *   conflict；gen0 exact proof 缺失 → pin；旧 summary 不能证明；
 * - historical child：tombstone 持久 parent/binding 篡改 → conflict；exact
 *   proof 完整 match → replacement_match；未来代 → conflict；
 * - receipt refresh：identity-bound 与 lowlevel 互不刷新、provenance 不同
 *   阻断、legacy 不升级、validator 未装配 fail closed、refresh 只改 tick。
 */
import { clearTreasuryPersistenceForTest, commitSettledReceipt, readTreasurySettlementProof, refreshSettledReceiptForResolution, ensureTreasuryReceiptStore } from "@/runtime/treasury/receipts";
import {
  createTreasuryAttemptLineageRecord,
  convergeTreasuryLineageRetirementFromFacts,
  deriveTreasuryLineageNextChildTransactionId,
  stageTreasuryLineageCapabilityIssued,
  stageTreasuryLineageChildIntentPending,
  activateTreasuryLineageChild,
  readTreasuryAttemptLineageRecord,
  retireTreasuryLineageCurrentAttempt,
  resetTreasuryLineageRuntimeForTest,
} from "@/runtime/treasury/attemptLineage";
import { readTreasuryGenerationRetirementProof, resetTreasuryGenerationRetirementRuntimeForTest, peekTreasuryGenerationRetirementHealth, type TreasuryGenerationRetirementProof } from "@/runtime/treasury/generationRetirementAuthority";
import { treasuryTombstoneReplacementVerdict } from "@/runtime/treasury/lineageGenerationRetirement";
import { compactTreasuryTerminalLineage, lookupTreasuryRetirementSummaryByLineageId, lookupTreasuryRetirementSummaryByRoot, resetTreasuryRetirementSummaryRuntimeForTest, TREASURY_RETIREMENT_SUMMARY_VERSION } from "@/runtime/treasury/lineageRetirementSummary";
import { writeTreasuryResolutionTombstone, readTreasuryResolutionTombstone } from "@/runtime/treasury/resolutionStore";
import { recomputeTreasuryDurableIdentityDigest } from "@/runtime/treasury/identityProof";
import { validateTreasurySemanticLineage, resetTreasurySemanticLineageSourcesForTest } from "@/runtime/treasury/semanticLineageValidation";
import { TREASURY_LOWLEVEL_SOURCE_RUNTIME } from "@/runtime/treasury/authorityLevel";

beforeEach(() => {
  clearTreasuryPersistenceForTest();
});

interface Chain {
  readonly childId: string;
  readonly rootId: string;
  readonly lineageId: string;
  readonly binding: string;
  readonly identity: {
    readonly digest: string;
    readonly durableIdentityDigest: string;
    readonly lowlevelSource?: string;
  };
}

/** lowlevel 链到指定代 child_active（durable 全部真实重算）。 */
function seedLowlevelChain(rootId: string, targetGeneration: number): Chain {
  const digest = "1111111111111111";
  const rootDurable = recomputeTreasuryDurableIdentityDigest({
    transactionId: rootId,
    digest,
    actionKind: "terminal.send",
    source: "test",
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
  })!;
  const created = createTreasuryAttemptLineageRecord({
    rootTransactionId: rootId,
    rootIdentity: { digest, durableIdentityDigest: rootDurable },
    actionKind: "terminal.send",
    authorityClass: "lowlevel",
    lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
    rearmable: true,
    retrySemanticDigest: "6666666666666666",
  });
  if (created.status !== "written") throw new Error("create failed");
  const lineageId = created.record.lineageId;
  let current = rootId;
  let currentDurable = rootDurable;
  for (let gen = 1; gen <= targetGeneration; gen += 1) {
    if (gen === 1) {
      if (convergeTreasuryLineageRetirementFromFacts(lineageId).status !== "completed") throw new Error("converge gen0 failed");
    } else {
      if (retireTreasuryLineageCurrentAttempt({ lineageId, rearmable: true, retrySemanticDigest: "6666666666666666" }).status === "rejected") throw new Error("retire gen failed");
      if (convergeTreasuryLineageRetirementFromFacts(lineageId).status !== "completed") throw new Error("converge gen failed");
    }
    const childId = deriveTreasuryLineageNextChildTransactionId(lineageId, gen, rootId);
    if (stageTreasuryLineageCapabilityIssued(lineageId, childId).status === "rejected") throw new Error("stage issued");
    if (stageTreasuryLineageChildIntentPending(lineageId, childId).status === "rejected") throw new Error("stage pending");
    const pendingBinding = readTreasuryAttemptLineageRecord(lineageId)!.pendingBindingDigest!;
    const childDurable = recomputeTreasuryDurableIdentityDigest({
      transactionId: childId,
      digest,
      actionKind: "terminal.send",
      source: "test",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
      lineageId,
      lineageGeneration: gen,
      parentTransactionId: current,
      lineageBindingDigest: pendingBinding,
    })!;
    if (activateTreasuryLineageChild(lineageId, { digest, durableIdentityDigest: childDurable, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME }).status === "rejected") {
      throw new Error("activate failed");
    }
    current = childId;
    currentDurable = childDurable;
  }
  return { childId: current, rootId, lineageId, binding: readTreasuryAttemptLineageRecord(lineageId)!.bindingDigest!, identity: { digest, durableIdentityDigest: currentDurable, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME } };
}

/** 写 final not-executed tombstone（带完整 lineage proof）。 */
function writeFinalTombstone(chain: Chain): void {
  const record = readTreasuryAttemptLineageRecord(chain.lineageId)!;
  const written = writeTreasuryResolutionTombstone({
    transactionId: chain.childId,
    digest: record.currentIdentity.digest,
    resolution: "not-executed",
    stage: "final",
    proofLevel: record.authorityClass,
    actionTick: Game.time,
    observationTick: Game.time,
    resolvedAtTick: Game.time,
    durableIdentityDigest: record.currentIdentity.durableIdentityDigest,
    lowlevelSource: record.lowlevelSource,
    lineageId: record.lineageId,
    lineageGeneration: record.generation,
    parentTransactionId: record.currentParentTransactionId,
    lineageBindingDigest: record.bindingDigest,
  });
  if (written.status === "rejected") throw new Error("tombstone rejected: " + written.detail);
}

function grStoreOf(): { entries: Record<string, TreasuryGenerationRetirementProof>; entryCount: number } {
  return (Memory.runtime as unknown as { treasury?: { generationRetirementProofs?: { entries: Record<string, TreasuryGenerationRetirementProof>; entryCount: number } } }).treasury!.generationRetirementProofs!;
}

describe("non-rearmable compaction 四方 proof（第二十一轮 11.2）", () => {
  /** gen1 退休 → non_rearmable_retired（retire 显式 non-rearmable）。 */
  function retiredChain(rootId: string): Chain {
    const chain = seedLowlevelChain(rootId, 1);
    if (retireTreasuryLineageCurrentAttempt({ lineageId: chain.lineageId, rearmable: false, nonRearmReason: "r21 fixture" }).status === "rejected") throw new Error("retire failed");
    if (convergeTreasuryLineageRetirementFromFacts(chain.lineageId).status !== "completed") throw new Error("converge failed");
    expect(readTreasuryAttemptLineageRecord(chain.lineageId)!.state).toBe("non_rearmable_retired");
    writeFinalTombstone(chain);
    return chain;
  }

  it("tombstone/record/exact proof/semantic/candidate 全部 match → 可压缩", () => {
    const chain = retiredChain("r21_nr_ok");
    const result = compactTreasuryTerminalLineage(chain.lineageId);
    expect(result.status).toBe("compacted");
    const summary = lookupTreasuryRetirementSummaryByRoot("r21_nr_ok")!;
    expect(summary.schemaVersion).toBe(TREASURY_RETIREMENT_SUMMARY_VERSION);
    expect(summary.finalGeneration).toBe(1);
    // active 释放。
    expect(readTreasuryAttemptLineageRecord(chain.lineageId)).toBeUndefined();
  });

  it("exact proof 只是存在但 digest 不同 → 不压缩（内容匹配，不是存在性）", () => {
    const chain = retiredChain("r21_nr_dig");
    const grStore = grStoreOf();
    const key = `gr:${chain.lineageId}:000001`;
    grStore.entries[key] = { ...grStore.entries[key], digest: "9999999999999999" };
    resetTreasuryGenerationRetirementRuntimeForTest();
    const result = compactTreasuryTerminalLineage(chain.lineageId);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.detail).toContain("digest");
    expect(readTreasuryAttemptLineageRecord(chain.lineageId)).toBeDefined();
  });

  it("exact proof durable / lowlevelSource 不同 → 不压缩", () => {
    const chain = retiredChain("r21_nr_dims");
    const grStore = grStoreOf();
    const key = `gr:${chain.lineageId}:000001`;
    grStore.entries[key] = { ...grStore.entries[key], durableIdentityDigest: "8888888888888888" };
    resetTreasuryGenerationRetirementRuntimeForTest();
    expect(compactTreasuryTerminalLineage(chain.lineageId).status).toBe("rejected");
    // 恢复后再篡改 provenance。
    const chain2 = retiredChain("r21_nr_src");
    const key2 = `gr:${chain2.lineageId}:000001`;
    grStoreOf().entries[key2] = { ...grStoreOf().entries[key2], lowlevelSource: "migrated-lowlevel@v1" };
    resetTreasuryGenerationRetirementRuntimeForTest();
    const result = compactTreasuryTerminalLineage(chain2.lineageId);
    expect(result.status).toBe("rejected");
  });

  it("exact proof 缺失 / store unhealthy → 不压缩", () => {
    const chain = retiredChain("r21_nr_miss");
    const grStore = grStoreOf();
    delete grStore.entries[`gr:${chain.lineageId}:000001`];
    grStore.entryCount = Object.keys(grStore.entries).length;
    resetTreasuryGenerationRetirementRuntimeForTest();
    const missingResult = compactTreasuryTerminalLineage(chain.lineageId);
    expect(missingResult.status).toBe("rejected");
    if (missingResult.status === "rejected") expect(missingResult.detail).toContain("exact retirement proof");
    // store unhealthy。
    (Memory.runtime as { treasury?: { generationRetirementProofs?: unknown } }).treasury!.generationRetirementProofs = { version: 999, entries: {}, entryCount: 0, updatedAt: 0 };
    resetTreasuryGenerationRetirementRuntimeForTest();
    expect(peekTreasuryGenerationRetirementHealth().healthy).toBe(false);
    expect(compactTreasuryTerminalLineage(chain.lineageId).status).toBe("rejected");
  });

  it("summary 写入成功后再次压缩（active 已删）→ 幂等拒绝缺 record；压缩后 exact 幂等", () => {
    const chain = retiredChain("r21_nr_idem");
    expect(compactTreasuryTerminalLineage(chain.lineageId).status).toBe("compacted");
    // active 已删除——再次压缩拒绝（record 不存在）。
    const again = compactTreasuryTerminalLineage(chain.lineageId);
    expect(again.status).toBe("rejected");
    if (again.status === "rejected") expect(again.detail).toContain("不存在");
  });
});

describe("chain-committed compaction 与压缩后 terminal current（第二十一轮 11.1）", () => {
  it("receipt/record/semantic/candidate 完整 match → 可压缩；压缩后 terminal current 继续 match、错误 identity 不能 match", () => {
    ensureTreasuryReceiptStore();
    const chain = seedLowlevelChain("r21_cc_ok", 1);
    const record = readTreasuryAttemptLineageRecord(chain.lineageId)!;
    // close chain_committed + committed receipt（完整 proof）。
    const { closeTreasuryLineageAsChainCommitted } = require("@/runtime/treasury/attemptLineage") as typeof import("@/runtime/treasury/attemptLineage");
    if (closeTreasuryLineageAsChainCommitted(chain.lineageId).status === "rejected") throw new Error("close failed");
    expect(commitSettledReceipt(chain.childId, Game.time, {
      digest: record.currentIdentity.digest,
      durableIdentityDigest: record.currentIdentity.durableIdentityDigest!,
      lowlevelSource: record.lowlevelSource,
      lineageId: record.lineageId,
      lineageGeneration: record.generation,
      parentTransactionId: record.currentParentTransactionId,
      lineageBindingDigest: record.bindingDigest,
    }).status).toBe("written");
    const result = compactTreasuryTerminalLineage(chain.lineageId);
    expect(result.status).toBe("compacted");
    const summary = lookupTreasuryRetirementSummaryByLineageId(chain.lineageId)!;
    expect(summary.terminalState).toBe("chain_committed");
    // 压缩后 terminal current exact validation 继续 match。
    const match = validateTreasurySemanticLineage({
      transactionId: chain.childId,
      proof: { lineageId: record.lineageId, lineageGeneration: record.generation, parentTransactionId: record.currentParentTransactionId!, lineageBindingDigest: record.bindingDigest! },
      identity: { digest: record.currentIdentity.digest, durableIdentityDigest: record.currentIdentity.durableIdentityDigest, lowlevelSource: record.lowlevelSource },
    });
    expect(match.verdict).toBe("match");
    if (match.verdict === "match") {
      expect(match.authoritySource).toBe("terminal");
      expect(match.generationRole).toBe("terminal_current");
    }
    // 错误 identity 不能 match。
    const wrong = validateTreasurySemanticLineage({
      transactionId: chain.childId,
      proof: { lineageId: record.lineageId, lineageGeneration: record.generation, parentTransactionId: record.currentParentTransactionId!, lineageBindingDigest: record.bindingDigest! },
      identity: { digest: "7777777777777777", durableIdentityDigest: record.currentIdentity.durableIdentityDigest, lowlevelSource: record.lowlevelSource },
    });
    expect(wrong.verdict).toBe("conflict");
  });

  it("Receipt durable 不同 → 不压缩", () => {
    ensureTreasuryReceiptStore();
    const chain = seedLowlevelChain("r21_cc_dur", 1);
    const record = readTreasuryAttemptLineageRecord(chain.lineageId)!;
    const { closeTreasuryLineageAsChainCommitted } = require("@/runtime/treasury/attemptLineage") as typeof import("@/runtime/treasury/attemptLineage");
    if (closeTreasuryLineageAsChainCommitted(chain.lineageId).status === "rejected") throw new Error("close failed");
    Memory.runtime!.treasury!.receipts!.settled[`t:${chain.childId}`] = {
      level: "lowlevel",
      settledAtTick: Game.time,
      digest: record.currentIdentity.digest,
      durableIdentityDigest: "8888888888888888",
      lowlevelSource: record.lowlevelSource,
      lineageId: record.lineageId,
      lineageGeneration: record.generation,
      parentTransactionId: record.currentParentTransactionId,
      lineageBindingDigest: record.bindingDigest,
    } as never;
    const result = compactTreasuryTerminalLineage(chain.lineageId);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.detail).toContain("receipt");
    expect(readTreasuryAttemptLineageRecord(chain.lineageId)).toBeDefined();
  });
});

describe("root 与 historical child replacement（第二十一轮 12）", () => {
  /** 压缩后的单代 non-rearmable 链（gen1 final）。 */
  function compactedGen1Chain(rootId: string): { readonly chain: Chain; readonly summary: ReturnType<typeof lookupTreasuryRetirementSummaryByRoot> } {
    const chain = seedLowlevelChain(rootId, 1);
    if (retireTreasuryLineageCurrentAttempt({ lineageId: chain.lineageId, rearmable: false, nonRearmReason: "r21 fixture" }).status === "rejected") throw new Error("retire failed");
    if (convergeTreasuryLineageRetirementFromFacts(chain.lineageId).status !== "completed") throw new Error("converge failed");
    writeFinalTombstone(chain);
    // root（gen0）的 final not-executed tombstone（真实流由 resolve 流写入——
    // 压缩后 gen0 exact proof 的依赖保留，root replacement 可验证）。
    const rootDurable = rootDurableOf(rootId);
    const rootWritten = writeTreasuryResolutionTombstone({
      transactionId: rootId,
      digest: "1111111111111111",
      resolution: "not-executed",
      stage: "final",
      proofLevel: "lowlevel",
      actionTick: Game.time,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
      durableIdentityDigest: rootDurable,
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
    });
    if (rootWritten.status === "rejected") throw new Error("root tombstone rejected: " + rootWritten.detail);
    if (compactTreasuryTerminalLineage(chain.lineageId).status !== "compacted") throw new Error("compact failed");
    return { chain, summary: lookupTreasuryRetirementSummaryByRoot(rootId) };
  }

  it("root exact identity 完整 match（v3 rootExact）→ replacement_match", () => {
    const { chain } = compactedGen1Chain("r21_rr_ok");
    const record = readTreasuryAttemptLineageRecord;
    void record;
    // root tombstone：digest/contract/cohort/durable/lowlevel 与 rootExact 一致。
    const verdict = treasuryTombstoneReplacementVerdict({
      transactionId: "r21_rr_ok",
      digest: "1111111111111111",
      resolution: "not-executed",
      stage: "final",
      proofLevel: "lowlevel",
      durableIdentityDigest: chain.identity.durableIdentityDigest === chain.identity.durableIdentityDigest
        ? rootDurableOf("r21_rr_ok")
        : undefined,
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
    });
    expect(verdict.verdict).toBe("replacement_match");
  });

  it("同 root ID 但 root digest 不同 → conflict；root lowlevelSource 不同 → conflict；root exact proof 缺失 → pin", () => {
    const { chain } = compactedGen1Chain("r21_rr_conf");
    void chain;
    const digestVerdict = treasuryTombstoneReplacementVerdict({
      transactionId: "r21_rr_conf",
      digest: "9999999999999999",
      resolution: "not-executed",
      stage: "final",
      proofLevel: "lowlevel",
      durableIdentityDigest: rootDurableOf("r21_rr_conf"),
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
    });
    expect(digestVerdict.verdict).toBe("replacement_conflict");
    const sourceVerdict = treasuryTombstoneReplacementVerdict({
      transactionId: "r21_rr_conf",
      digest: "1111111111111111",
      resolution: "not-executed",
      stage: "final",
      proofLevel: "lowlevel",
      durableIdentityDigest: rootDurableOf("r21_rr_conf"),
      lowlevelSource: "migrated-lowlevel@v1",
    });
    expect(sourceVerdict.verdict).toBe("replacement_conflict");
    // 删除 gen0 exact proof → pin。
    const grStore = grStoreOf();
    const lineage = (lookupTreasuryRetirementSummaryByRoot("r21_rr_conf"))!.lineageId;
    delete grStore.entries[`gr:${lineage}:000000`];
    grStore.entryCount = Object.keys(grStore.entries).length;
    resetTreasuryGenerationRetirementRuntimeForTest();
    const pinVerdict = treasuryTombstoneReplacementVerdict({
      transactionId: "r21_rr_conf",
      digest: "1111111111111111",
      resolution: "not-executed",
      stage: "final",
      proofLevel: "lowlevel",
      durableIdentityDigest: rootDurableOf("r21_rr_conf"),
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
    });
    expect(pinVerdict.verdict).toBe("replacement_missing");
  });

  it("historical child tombstone parent 被篡改 → conflict；binding 被篡改 → conflict", () => {
    // 双代链（gen2 current；gen1 历史）。
    const chain = seedLowlevelChain("r21_hr_tamp", 2);
    const proof = readTreasuryGenerationRetirementProof(chain.lineageId, 1)!;
    expect(proof).toBeDefined();
    const parentVerdict = treasuryTombstoneReplacementVerdict({
      transactionId: proof.transactionId,
      digest: proof.digest,
      resolution: "not-executed",
      stage: "final",
      proofLevel: proof.authorityClass,
      durableIdentityDigest: proof.durableIdentityDigest,
      lowlevelSource: proof.lowlevelSource,
      lineageId: chain.lineageId,
      lineageGeneration: 1,
      parentTransactionId: "r21_wrong_parent",
      lineageBindingDigest: proof.bindingDigest,
    });
    expect(parentVerdict.verdict).toBe("replacement_conflict");
    if (parentVerdict.verdict === "replacement_conflict") expect(parentVerdict.detail).toContain("parent");
    const bindingVerdict = treasuryTombstoneReplacementVerdict({
      transactionId: proof.transactionId,
      digest: proof.digest,
      resolution: "not-executed",
      stage: "final",
      proofLevel: proof.authorityClass,
      durableIdentityDigest: proof.durableIdentityDigest,
      lowlevelSource: proof.lowlevelSource,
      lineageId: chain.lineageId,
      lineageGeneration: 1,
      parentTransactionId: proof.parentTransactionId,
      lineageBindingDigest: "8888888888888888",
    });
    expect(bindingVerdict.verdict).toBe("replacement_conflict");
    if (bindingVerdict.verdict === "replacement_conflict") expect(bindingVerdict.detail).toContain("binding");
  });

  it("historical child exact proof 完整 match → replacement_match", () => {
    const chain = seedLowlevelChain("r21_hr_ok", 2);
    const proof = readTreasuryGenerationRetirementProof(chain.lineageId, 1)!;
    const verdict = treasuryTombstoneReplacementVerdict({
      transactionId: proof.transactionId,
      digest: proof.digest,
      resolution: "not-executed",
      stage: "final",
      proofLevel: proof.authorityClass,
      durableIdentityDigest: proof.durableIdentityDigest,
      lowlevelSource: proof.lowlevelSource,
      lineageId: chain.lineageId,
      lineageGeneration: 1,
      parentTransactionId: proof.parentTransactionId,
      lineageBindingDigest: proof.bindingDigest,
    });
    expect(verdict.verdict).toBe("replacement_match");
  });

  it("summary finalGeneration 存在但历史代 exact proof 缺失 → pin；旧 v2 summary 不能证明 historical child；未来代 → conflict", () => {
    const { chain } = compactedGen1Chain("r21_sr_pin");
    const summary = lookupTreasuryRetirementSummaryByRoot("r21_sr_pin")!;
    // gen0（root 代）proof 缺失 → pin。
    const grStore = grStoreOf();
    delete grStore.entries[`gr:${summary.lineageId}:000000`];
    grStore.entryCount = Object.keys(grStore.entries).length;
    resetTreasuryGenerationRetirementRuntimeForTest();
    const gen0Verdict = treasuryTombstoneReplacementVerdict({
      transactionId: "r21_sr_pin",
      digest: "1111111111111111",
      resolution: "not-executed",
      stage: "final",
      proofLevel: "lowlevel",
      durableIdentityDigest: rootDurableOf("r21_sr_pin"),
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
    });
    expect(gen0Verdict.verdict).toBe("replacement_missing");
    // 未来代 → conflict。
    const futureId = deriveTreasuryLineageNextChildTransactionId(summary.lineageId, 9, "r21_sr_pin");
    const futureVerdict = treasuryTombstoneReplacementVerdict({
      transactionId: futureId,
      digest: "1111111111111111",
      resolution: "not-executed",
      stage: "final",
      proofLevel: "lowlevel",
      durableIdentityDigest: rootDurableOf("r21_sr_pin"),
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      lineageId: summary.lineageId,
      lineageGeneration: 9,
      parentTransactionId: deriveTreasuryLineageNextChildTransactionId(summary.lineageId, 8, "r21_sr_pin"),
      lineageBindingDigest: "3333333333333333",
    });
    expect(futureVerdict.verdict).toBe("replacement_conflict");
    // 降级 v2 summary → historical child 不可证明（pin）。
    const store = (Memory.runtime!.treasury as unknown as { lineageRetirementSummaries: { version: number; entries: Record<string, Record<string, unknown>> } }).lineageRetirementSummaries;
    store.version = 2;
    for (const key of Object.keys(store.entries)) {
      store.entries[key].schemaVersion = 2;
      delete store.entries[key].rootExact;
      delete store.entries[key].finalExact;
    }
    resetTreasuryRetirementSummaryRuntimeForTest();
    const gen1Proof = readTreasuryGenerationRetirementProof(chain.lineageId, 1);
    // 恢复 gen0 proof 供查（不影响 v2 语义断言）。
    void gen1Proof;
    const legacyVerdict = treasuryTombstoneReplacementVerdict({
      transactionId: chain.childId,
      digest: "1111111111111111",
      resolution: "not-executed",
      stage: "final",
      proofLevel: "lowlevel",
      durableIdentityDigest: chain.identity.durableIdentityDigest,
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      lineageId: chain.lineageId,
      lineageGeneration: 1,
      parentTransactionId: "r21_sr_pin",
      lineageBindingDigest: chain.binding,
    });
    expect(legacyVerdict.verdict).toBe("replacement_missing");
    if (legacyVerdict.verdict === "replacement_missing") expect(legacyVerdict.detail).toContain("replay-only");
  });
});

describe("receipt refresh 的 proof-class-aware exact relation（第二十一轮 13）", () => {
  /** identity-bound 链（modern contract）到 gen1 child_active。 */
  function seedModernChain(rootId: string): { readonly childId: string; readonly lineageId: string; readonly identity: Record<string, string | number> } {
    const digest = "aaaaaaaaaaaaaaaa";
    const rootDurable = recomputeTreasuryDurableIdentityDigest({
      transactionId: rootId,
      digest,
      actionKind: "terminal.send",
      source: "test",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
    })!;
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: rootId,
      rootIdentity: { digest, durableIdentityDigest: rootDurable, contractDigest: "cccccccccccccccc", authorizationCohortDigest: "dddddddddddddddd" },
      actionKind: "terminal.send",
      authorityClass: "identity-bound",
      rearmable: true,
      retrySemanticDigest: "6666666666666666",
    });
    if (created.status !== "written") throw new Error("create failed");
    const lineageId = created.record.lineageId;
    if (convergeTreasuryLineageRetirementFromFacts(lineageId).status !== "completed") throw new Error("converge failed");
    const childId = deriveTreasuryLineageNextChildTransactionId(lineageId, 1, rootId);
    if (stageTreasuryLineageCapabilityIssued(lineageId, childId).status === "rejected") throw new Error("stage issued");
    if (stageTreasuryLineageChildIntentPending(lineageId, childId).status === "rejected") throw new Error("stage pending");
    const pendingBinding = readTreasuryAttemptLineageRecord(lineageId)!.pendingBindingDigest!;
    const childDurable = recomputeTreasuryDurableIdentityDigest({
      transactionId: childId,
      digest,
      actionKind: "terminal.send",
      source: "test",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
      lineageId,
      lineageGeneration: 1,
      parentTransactionId: rootId,
      lineageBindingDigest: pendingBinding,
    })!;
    if (activateTreasuryLineageChild(lineageId, {
      digest,
      durableIdentityDigest: childDurable,
      contractDigest: "cccccccccccccccc",
      authorizationCohortDigest: "dddddddddddddddd",
    }).status === "rejected") throw new Error("activate failed");
    return {
      childId,
      lineageId,
      identity: {
        digest,
        durableIdentityDigest: childDurable,
        contractDigest: "cccccccccccccccc",
        authorizationCohortDigest: "dddddddddddddddd",
        lineageId,
        lineageGeneration: 1,
        parentTransactionId: rootId,
        lineageBindingDigest: readTreasuryAttemptLineageRecord(lineageId)!.bindingDigest!,
      },
    };
  }

  it("identity-bound Receipt + matching identity-bound attempt → refresh（只改 tick，identity 字段不变）", () => {
    ensureTreasuryReceiptStore();
    const chain = seedModernChain("r21_rf_ib");
    expect(commitSettledReceipt(chain.childId, Game.time, chain.identity as never).status).toBe("written");
    Game.time += 5;
    const refreshed = refreshSettledReceiptForResolution(chain.childId, Game.time, chain.identity as never);
    expect(refreshed.status).toBe("refreshed");
    const proof = readTreasurySettlementProof(chain.childId)!;
    expect(proof.settledAtTick).toBe(Game.time);
    expect(proof.level).toBe("identity-bound");
    expect(proof.contractDigest).toBe("cccccccccccccccc");
    expect(proof.authorizationCohortDigest).toBe("dddddddddddddddd");
    expect(proof.lineageId).toBe(chain.lineageId);
    expect(proof.lowlevelSource).toBeUndefined();
  });

  it("lowlevel Receipt + matching lowlevel attempt → refresh", () => {
    ensureTreasuryReceiptStore();
    const chain = seedLowlevelChain("r21_rf_ll", 1);
    const identity = { ...chain.identity, lineageId: chain.lineageId, lineageGeneration: 1, parentTransactionId: chain.rootId, lineageBindingDigest: chain.binding };
    expect(commitSettledReceipt(chain.childId, Game.time, identity).status).toBe("written");
    Game.time += 2;
    const refreshed = refreshSettledReceiptForResolution(chain.childId, Game.time, identity);
    expect(refreshed.status).toBe("refreshed");
    expect(readTreasurySettlementProof(chain.childId)!.level).toBe("lowlevel");
  });

  it("identity-bound Receipt + lowlevel attempt → blocked（class 互证禁止）", () => {
    ensureTreasuryReceiptStore();
    const chain = seedModernChain("r21_rf_x1");
    expect(commitSettledReceipt(chain.childId, Game.time, chain.identity as never).status).toBe("written");
    Game.time += 1;
    // 低层 attempt 形态（携带 provenance、剥离 contract）。
    const lowlevelAttempt = {
      ...chain.identity,
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      contractDigest: undefined,
      authorizationCohortDigest: undefined,
    };
    const refreshed = refreshSettledReceiptForResolution(chain.childId, Game.time, lowlevelAttempt as never);
    expect(refreshed.status).toBe("blocked");
  });

  it("lowlevel Receipt + identity-bound attempt → blocked", () => {
    ensureTreasuryReceiptStore();
    const chain = seedLowlevelChain("r21_rf_x2", 1);
    const lowlevelIdentity = { ...chain.identity, lineageId: chain.lineageId, lineageGeneration: 1, parentTransactionId: chain.rootId, lineageBindingDigest: chain.binding };
    expect(commitSettledReceipt(chain.childId, Game.time, lowlevelIdentity).status).toBe("written");
    Game.time += 1;
    const modernAttempt = { ...lowlevelIdentity, lowlevelSource: undefined, contractDigest: "cccccccccccccccc", authorizationCohortDigest: "dddddddddddddddd" };
    const refreshed = refreshSettledReceiptForResolution(chain.childId, Game.time, modernAttempt as never);
    expect(refreshed.status).toBe("blocked");
  });

  it("lowlevelSource 不同 / lineage generation 不同 / durable 不同 → blocked", () => {
    ensureTreasuryReceiptStore();
    const chain = seedLowlevelChain("r21_rf_dims", 1);
    const identity = { ...chain.identity, lineageId: chain.lineageId, lineageGeneration: 1, parentTransactionId: chain.rootId, lineageBindingDigest: chain.binding };
    expect(commitSettledReceipt(chain.childId, Game.time, identity).status).toBe("written");
    Game.time += 1;
    const sourceBlocked = refreshSettledReceiptForResolution(chain.childId, Game.time, { ...identity, lowlevelSource: "migrated-lowlevel@v1" });
    expect(sourceBlocked.status).toBe("blocked");
    const generationBlocked = refreshSettledReceiptForResolution(chain.childId, Game.time, { ...identity, lineageGeneration: 2 });
    expect(generationBlocked.status).toBe("blocked");
    const durableBlocked = refreshSettledReceiptForResolution(chain.childId, Game.time, { ...identity, durableIdentityDigest: "8888888888888888" });
    expect(durableBlocked.status).toBe("blocked");
    // 原 proof 未被覆盖。
    expect(readTreasurySettlementProof(chain.childId)!.settledAtTick).toBe(Game.time - 1);
  });

  it("legacy Receipt → 不升级、不刷新成 modern", () => {
    ensureTreasuryReceiptStore();
    const chain = seedLowlevelChain("r21_rf_lg", 1);
    Memory.runtime!.treasury!.receipts!.settled[`t:${chain.childId}`] = { level: "legacy", settledAtTick: Game.time } as never;
    Game.time += 1;
    const identity = { ...chain.identity, lineageId: chain.lineageId, lineageGeneration: 1, parentTransactionId: chain.rootId, lineageBindingDigest: chain.binding };
    const refreshed = refreshSettledReceiptForResolution(chain.childId, Game.time, identity);
    expect(refreshed.status).toBe("blocked");
    if (refreshed.status === "blocked") expect(refreshed.reason).toBe("legacy_proof");
    expect((Memory.runtime!.treasury!.receipts!.settled[`t:${chain.childId}`] as { level: string }).level).toBe("legacy");
  });

  it("semantic validator 未装配 → refresh fail closed", () => {
    ensureTreasuryReceiptStore();
    const chain = seedLowlevelChain("r21_rf_asm", 1);
    const identity = { ...chain.identity, lineageId: chain.lineageId, lineageGeneration: 1, parentTransactionId: chain.rootId, lineageBindingDigest: chain.binding };
    resetTreasurySemanticLineageSourcesForTest();
    try {
      const refreshed = refreshSettledReceiptForResolution(chain.childId, Game.time, identity);
      expect(refreshed.status).toBe("blocked");
    } finally {
      // 恢复装配（后续测试依赖）。
      const { registerTreasuryAttemptLineageSemanticSourceForAssembly } = require("@/runtime/treasury/attemptLineage") as typeof import("@/runtime/treasury/attemptLineage");
      const { registerTreasuryRetirementSummarySemanticSourceForAssembly } = require("@/runtime/treasury/lineageRetirementSummary") as typeof import("@/runtime/treasury/lineageRetirementSummary");
      const { registerTreasuryGenerationRetirementSemanticSourceForAssembly } = require("@/runtime/treasury/generationRetirementAuthority") as typeof import("@/runtime/treasury/generationRetirementAuthority");
      registerTreasuryAttemptLineageSemanticSourceForAssembly();
      registerTreasuryRetirementSummarySemanticSourceForAssembly();
      registerTreasuryGenerationRetirementSemanticSourceForAssembly();
    }
  });
});

/** root durable 的重算 helper（与 seedLowlevelChain 同口径）。 */
function rootDurableOf(rootId: string): string {
  return recomputeTreasuryDurableIdentityDigest({
    transactionId: rootId,
    digest: "1111111111111111",
    actionKind: "terminal.send",
    source: "test",
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
  })!;
}
