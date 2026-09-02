/**
 * 【第二十一轮】child-active commit recovery 与 tombstone replacement /
 * exact retirement proof 矩阵测试。
 *
 * 覆盖（任务书第八/九/十节与十七节矩阵）：
 * - child_active 补完成：完整 Receipt exact proof match 才 close chain_
 *   committed → read-back → 释放 Intent；仅 binding/generation 相同但
 *   digest/contract/cohort/durable/class/provenance 不同 → 不关闭；
 * - lineage 终态写失败（close 拒绝）→ Intent 与 child_active 保留；
 * - Receipt legacy / semantic conflict / store unhealthy / receipt 不存在 →
 *   保留全部证据、零状态变化；
 * - current generation tombstone：三段全 true + matching exact proof →
 *   replacement_match；三段布尔不构成 replacement（proof 缺失/冲突 → pin）；
 *   record 已 rearm_ready 但 proof 缺失 → 仍 pin；
 * - exact retirement proof 的 class required/forbidden 矩阵、root 绑定
 *   canonical 派生、全局 transactionId 唯一（写入拒绝 + load 整体 unhealthy）、
 *   byAttempt O(1) 索引。
 */
import { clearTreasuryPersistenceForTest, commitSettledReceipt, readTreasurySettlementProof, lookupTreasurySettledReceipt, ensureTreasuryReceiptStore } from "@/runtime/treasury/receipts";
import {
  createTreasuryAttemptLineageRecord,
  convergeTreasuryLineageRetirementFromFacts,
  deriveTreasuryLineageNextChildTransactionId,
  stageTreasuryLineageCapabilityIssued,
  stageTreasuryLineageChildIntentPending,
  activateTreasuryLineageChild,
  readTreasuryAttemptLineageRecord,
  recoverTreasuryAttemptLineageAtTickBoundary,
  retireTreasuryLineageCurrentAttempt,
  setTreasuryLineageReceiptReaderForAssembly,
  isolateTreasuryLineageForensically,
} from "@/runtime/treasury/attemptLineage";
import { writeTreasuryIntentEntry, readTreasuryIntentEntry } from "@/runtime/treasury/intents";
import {
  persistTreasuryGenerationRetirementProof,
  readTreasuryGenerationRetirementProof,
  lookupTreasuryGenerationRetirementProofByAttemptId,
  peekTreasuryGenerationRetirementHealth,
  resetTreasuryGenerationRetirementRuntimeForTest,
  generationRetirementEvents,
  computeTreasuryGenerationRootIdentityDigest,
  type TreasuryGenerationRetirementProof,
} from "@/runtime/treasury/generationRetirementAuthority";
import { treasuryTombstoneReplacementVerdict } from "@/runtime/treasury/lineageGenerationRetirement";
import { writeTreasuryResolutionTombstone, readTreasuryResolutionTombstone } from "@/runtime/treasury/resolutionStore";
import { recomputeTreasuryDurableIdentityDigest } from "@/runtime/treasury/identityProof";

/** GRA store 的测试直连视图（Memory 类型收窄）。 */
function grStoreOf(): { entries: Record<string, TreasuryGenerationRetirementProof>; entryCount: number } {
  return (Memory.runtime as unknown as { treasury?: { generationRetirementProofs?: { entries: Record<string, TreasuryGenerationRetirementProof>; entryCount: number } } }).treasury!.generationRetirementProofs!;
}
import { TREASURY_LOWLEVEL_SOURCE_RUNTIME, validateTreasuryLowlevelSourceField } from "@/runtime/treasury/authorityLevel";

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  // facade 装配的 receipt 完整 proof reader（与 production 同款——只透传
  // modern_committed 的完整 settlement proof 视图）。
  setTreasuryLineageReceiptReaderForAssembly((transactionId) => {
    const lookup = lookupTreasurySettledReceipt(transactionId);
    if (lookup.status !== "modern_committed") return undefined;
    return {
      level: lookup.proof.level,
      digest: lookup.proof.digest,
      contractDigest: lookup.proof.contractDigest,
      authorizationCohortDigest: lookup.proof.authorizationCohortDigest,
      durableIdentityDigest: lookup.proof.durableIdentityDigest,
      lowlevelSource: lookup.proof.lowlevelSource,
      lineageId: lookup.proof.lineageId,
      lineageGeneration: lookup.proof.lineageGeneration,
      parentTransactionId: lookup.proof.parentTransactionId,
      lineageBindingDigest: lookup.proof.lineageBindingDigest,
    };
  });
});

interface Chain {
  readonly childId: string;
  readonly lineageId: string;
  readonly binding: string;
  readonly identity: {
    readonly digest: string;
    readonly durableIdentityDigest: string;
    readonly lowlevelSource?: string;
    readonly contractDigest?: string;
    readonly authorizationCohortDigest?: string;
  };
}

/** lowlevel 链到 gen1 child_active（durable 重算）。 */
function seedChildActive(rootId: string, digest = "1111111111111111"): Chain {
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
  if (activateTreasuryLineageChild(lineageId, { digest, durableIdentityDigest: childDurable, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME }).status === "rejected") {
    throw new Error("activate failed");
  }
  return { childId, lineageId, binding: readTreasuryAttemptLineageRecord(lineageId)!.bindingDigest!, identity: { digest, durableIdentityDigest: childDurable, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME } };
}

/** child_active 链的完整 lineage identity（receipt/verifier 输入）。 */
function fullIdentityOf(chain: Chain): Chain["identity"] & {
  readonly lineageId: string;
  readonly lineageGeneration: number;
  readonly parentTransactionId: string;
  readonly lineageBindingDigest: string;
} {
  return {
    ...chain.identity,
    lineageId: chain.lineageId,
    lineageGeneration: 1,
    parentTransactionId: (Memory.runtime as unknown as never) && chainParentOf(chain),
    lineageBindingDigest: chain.binding,
  };
}

function chainParentOf(chain: Chain): string {
  const record = readTreasuryAttemptLineageRecord(chain.lineageId)!;
  return record.currentParentTransactionId!;
}

/** 写入 child intent（残留 Intent——验证释放顺序）。 */
function seedChildIntent(chain: Chain): void {
  const identity = fullIdentityOf(chain);
  const base = {
    authorityLevel: "lowlevel" as const,
    lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
    transactionId: chain.childId,
    digest: identity.digest,
    actionKind: "terminal.send",
    kind: "terminal.send",
    source: "test",
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
    outcome: "started_unknown",
    settlement: "executing",
    auditSource: "test",
    lineageId: identity.lineageId,
    lineageGeneration: identity.lineageGeneration,
    parentTransactionId: identity.parentTransactionId,
    lineageBindingDigest: identity.lineageBindingDigest,
    createdAtTick: Game.time,
    updatedAtTick: Game.time,
  };
  const durable = recomputeTreasuryDurableIdentityDigest(base as never) ?? identity.durableIdentityDigest;
  const written = writeTreasuryIntentEntry({ ...base, durableIdentityDigest: durable });
  if (written.status === "rejected") throw new Error("intent rejected: " + written.detail);
}

describe("child-active commit recovery（第二十一轮 8）", () => {
  it("Receipt exact identity 完整 match → close chain_committed 后释放 Intent", () => {
    ensureTreasuryReceiptStore();
    const chain = seedChildActive("r21_cr_ok");
    seedChildIntent(chain);
    const identity = fullIdentityOf(chain);
    expect(commitSettledReceipt(chain.childId, Game.time, identity).status).toBe("written");
    const result = recoverTreasuryAttemptLineageAtTickBoundary();
    expect(result.chainCommitCompletions).toBe(1);
    const record = readTreasuryAttemptLineageRecord(chain.lineageId)!;
    expect(record.state).toBe("chain_committed");
    // close 成功后 Intent 已释放（顺序：close → 释放）。
    expect(readTreasuryIntentEntry(chain.childId)).toBeUndefined();
  });

  it("close 失败（状态已被外部推进为 forensic）→ Intent 保留、child_active 语义保留", () => {
    ensureTreasuryReceiptStore();
    const chain = seedChildActive("r21_cr_close");
    seedChildIntent(chain);
    const identity = fullIdentityOf(chain);
    expect(commitSettledReceipt(chain.childId, Game.time, identity).status).toBe("written");
    // 外部先把 record 推到 forensic_isolated（close 将拒绝——模拟终态写失败）。
    const isolated = isolateTreasuryLineageForensically(chain.lineageId, "r21 fixture");
    if (isolated.status === "rejected") throw new Error("isolate failed");
    const result = recoverTreasuryAttemptLineageAtTickBoundary();
    expect(result.chainCommitCompletions).toBe(0);
    // Intent 保留（不先删最后一份证据）。
    expect(readTreasuryIntentEntry(chain.childId)).toBeDefined();
  });

  it("Receipt 仅 generation+binding 相同但 digest 不同 → 不关闭", () => {
    ensureTreasuryReceiptStore();
    const chain = seedChildActive("r21_cr_dig");
    const identity = fullIdentityOf(chain);
    // 手塞 receipt：lineage 四字段与 record 匹配（binding/generation 相同）、digest 不同。
    Memory.runtime!.treasury!.receipts!.settled[`t:${chain.childId}`] = {
      level: "lowlevel",
      settledAtTick: Game.time,
      digest: "9999999999999999",
      durableIdentityDigest: identity.durableIdentityDigest,
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      lineageId: identity.lineageId,
      lineageGeneration: 1,
      parentTransactionId: identity.parentTransactionId,
      lineageBindingDigest: identity.lineageBindingDigest,
    } as never;
    const result = recoverTreasuryAttemptLineageAtTickBoundary();
    expect(result.chainCommitCompletions).toBe(0);
    expect(readTreasuryAttemptLineageRecord(chain.lineageId)!.state).toBe("child_active");
  });

  it("Receipt durable 不同 → 不关闭（durable 维度进入补完成验证）", () => {
    ensureTreasuryReceiptStore();
    const chain = seedChildActive("r21_cr_dur");
    const identity = fullIdentityOf(chain);
    Memory.runtime!.treasury!.receipts!.settled[`t:${chain.childId}`] = {
      level: "lowlevel",
      settledAtTick: Game.time,
      digest: identity.digest,
      durableIdentityDigest: "8888888888888888",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      lineageId: identity.lineageId,
      lineageGeneration: 1,
      parentTransactionId: identity.parentTransactionId,
      lineageBindingDigest: identity.lineageBindingDigest,
    } as never;
    expect(recoverTreasuryAttemptLineageAtTickBoundary().chainCommitCompletions).toBe(0);
    expect(readTreasuryAttemptLineageRecord(chain.lineageId)!.state).toBe("child_active");
  });

  it("Receipt proof class 不同（lowlevel record + identity-bound receipt）→ 不关闭", () => {
    ensureTreasuryReceiptStore();
    const chain = seedChildActive("r21_cr_cls");
    const identity = fullIdentityOf(chain);
    Memory.runtime!.treasury!.receipts!.settled[`t:${chain.childId}`] = {
      level: "identity-bound",
      settledAtTick: Game.time,
      digest: identity.digest,
      durableIdentityDigest: identity.durableIdentityDigest,
      lineageId: identity.lineageId,
      lineageGeneration: 1,
      parentTransactionId: identity.parentTransactionId,
      lineageBindingDigest: identity.lineageBindingDigest,
    } as never;
    expect(recoverTreasuryAttemptLineageAtTickBoundary().chainCommitCompletions).toBe(0);
    expect(readTreasuryAttemptLineageRecord(chain.lineageId)!.state).toBe("child_active");
  });

  it("Receipt lowlevelSource 不同（migrated provenance）→ 不关闭", () => {
    ensureTreasuryReceiptStore();
    const chain = seedChildActive("r21_cr_lls");
    const identity = fullIdentityOf(chain);
    Memory.runtime!.treasury!.receipts!.settled[`t:${chain.childId}`] = {
      level: "lowlevel",
      settledAtTick: Game.time,
      digest: identity.digest,
      durableIdentityDigest: identity.durableIdentityDigest,
      lowlevelSource: "migrated-lowlevel@v1",
      lineageId: identity.lineageId,
      lineageGeneration: 1,
      parentTransactionId: identity.parentTransactionId,
      lineageBindingDigest: identity.lineageBindingDigest,
    } as never;
    expect(recoverTreasuryAttemptLineageAtTickBoundary().chainCommitCompletions).toBe(0);
  });

  it("Receipt legacy（缺 lineage proof 的 tr1_）→ 不关闭", () => {
    ensureTreasuryReceiptStore();
    const chain = seedChildActive("r21_cr_leg");
    const identity = fullIdentityOf(chain);
    Memory.runtime!.treasury!.receipts!.settled[`t:${chain.childId}`] = {
      level: "lowlevel",
      settledAtTick: Game.time,
      digest: identity.digest,
      durableIdentityDigest: identity.durableIdentityDigest,
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
    } as never;
    // lookup 归一为 legacy_committed（tr1_ 缺 proof）→ reader 返回 undefined →
    // 不关闭（child_active 保持）。
    expect(recoverTreasuryAttemptLineageAtTickBoundary().chainCommitCompletions).toBe(0);
    expect(readTreasuryAttemptLineageRecord(chain.lineageId)!.state).toBe("child_active");
  });

  it("Receipt 不存在 → child_active 保持", () => {
    const chain = seedChildActive("r21_cr_abs");
    expect(recoverTreasuryAttemptLineageAtTickBoundary().chainCommitCompletions).toBe(0);
    expect(readTreasuryAttemptLineageRecord(chain.lineageId)!.state).toBe("child_active");
  });

  it("receipt store unhealthy → 零状态变化（child_active 保留）", () => {
    const chain = seedChildActive("r21_cr_unh");
    // 手动破坏 receipt store 版本（health fail closed）。
    (Memory.runtime as { treasury?: { receipts?: { version: number } } }).treasury!.receipts = { version: 999, settled: {}, entryCount: 0, updatedAt: 0 } as never;
    const result = recoverTreasuryAttemptLineageAtTickBoundary();
    expect(result.chainCommitCompletions).toBe(0);
    expect(readTreasuryAttemptLineageRecord(chain.lineageId)!.state).toBe("child_active");
  });
});

describe("current generation tombstone replacement（第二十一轮 9）", () => {
  /** 三段全 true 的当前代（gen0 root retired → rearm_ready）+ final tombstone。 */
  function seedRetiredRoot(rootId: string, digest = "1111111111111111"): { readonly lineageId: string; readonly tombstone: ReturnType<typeof readTreasuryResolutionTombstone> } {
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
    if (created.status !== "written") throw new Error("unreachable");
    const lineageId = created.record.lineageId;
    if (convergeTreasuryLineageRetirementFromFacts(lineageId).status !== "completed") throw new Error("converge failed");
    const record = readTreasuryAttemptLineageRecord(lineageId)!;
    expect(record.state).toBe("rearm_ready");
    const written = writeTreasuryResolutionTombstone({
      transactionId: rootId,
      digest: record.currentIdentity.digest,
      resolution: "not-executed",
      stage: "final",
      proofLevel: record.authorityClass,
      actionTick: Game.time,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
      durableIdentityDigest: record.currentIdentity.durableIdentityDigest,
      lowlevelSource: record.lowlevelSource,
    });
    if (written.status === "rejected") throw new Error("tombstone rejected");
    return { lineageId, tombstone: readTreasuryResolutionTombstone(rootId) };
  }

  it("三段全 true 且 exact proof 完整 match → replacement_match", () => {
    const { tombstone } = seedRetiredRoot("r21_tr_ok");
    const verdict = treasuryTombstoneReplacementVerdict(tombstone!);
    expect(verdict.verdict).toBe("replacement_match");
  });

  it("三段全 true 但 exact proof 缺失 → replacement_missing（三阶段布尔不构成 replacement）", () => {
    const { lineageId, tombstone } = seedRetiredRoot("r21_tr_miss");
    // 强制删除 gen0 exact proof（release 通道有当前代保留——直接操作 Memory）。
    const grStore = grStoreOf();
    delete grStore.entries[`gr:${lineageId}:000000`];
    grStore.entryCount = Object.keys(grStore.entries).length;
    resetTreasuryGenerationRetirementRuntimeForTest();
    const verdict = treasuryTombstoneReplacementVerdict(tombstone!);
    expect(verdict.verdict).toBe("replacement_missing");
    if (verdict.verdict === "replacement_missing") expect(verdict.detail).toContain("exact retirement proof");
  });

  it("record 已 rearm_ready 但 proof 被篡改（digest 不同）→ conflict/pin（不得因状态推进而驱逐）", () => {
    const { lineageId, tombstone } = seedRetiredRoot("r21_tr_tamp");
    const store = grStoreOf();
    const key = `gr:${lineageId}:000000`;
    store.entries[key] = { ...store.entries[key], digest: "9999999999999999" };
    resetTreasuryGenerationRetirementRuntimeForTest();
    const verdict = treasuryTombstoneReplacementVerdict(tombstone!);
    expect(verdict.verdict).toBe("replacement_conflict");
  });

  it("proof lowlevelSource 不同 → conflict；proof store unhealthy → pin", () => {
    const { lineageId, tombstone } = seedRetiredRoot("r21_tr_src");
    const store = grStoreOf();
    const key = `gr:${lineageId}:000000`;
    store.entries[key] = { ...store.entries[key], lowlevelSource: "migrated-lowlevel@v1" };
    resetTreasuryGenerationRetirementRuntimeForTest();
    const verdict = treasuryTombstoneReplacementVerdict(tombstone!);
    expect(verdict.verdict).toBe("replacement_conflict");
    // store unhealthy（版本破坏）→ pin。
    (Memory.runtime as { treasury?: { generationRetirementProofs?: unknown } }).treasury!.generationRetirementProofs = { version: 999, entries: {}, entryCount: 0, updatedAt: 0 };
    resetTreasuryGenerationRetirementRuntimeForTest();
    const unhealthyVerdict = treasuryTombstoneReplacementVerdict(tombstone!);
    expect(unhealthyVerdict.verdict).toBe("store_unhealthy");
  });
});

describe("exact retirement proof class 矩阵与索引（第二十一轮 10）", () => {
  /** 合法 lowlevel gen0 proof 输入（root 绑定真实派生）。 */
  function lowlevelProofOf(rootId: string, lineageId: string): TreasuryGenerationRetirementProof {
    const rootIdentity = { digest: "1111111111111111", durableIdentityDigest: "2222222222222222" };
    return {
      schemaVersion: 2 as const,
      identityProfile: "lowlevel" as const,
      lineageId,
      rootTransactionId: rootId,
      rootIdentityDigest: computeTreasuryGenerationRootIdentityDigest(rootIdentity),
      generation: 0,
      transactionId: rootId,
      digest: "1111111111111111",
      durableIdentityDigest: "2222222222222222",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      authorityClass: "lowlevel",
      resolution: "not_executed",
      retirement: { lineagePublished: true, authorityReleased: true, markerCleaned: true },
      completedAtTick: Game.time,
    };
  }

  /** 合法 identity-bound modern gen0 proof 输入。 */
  function modernProofOf(rootId: string, lineageId: string): TreasuryGenerationRetirementProof {
    const rootIdentity = {
      digest: "1111111111111111",
      durableIdentityDigest: "2222222222222222",
      contractDigest: "cccccccccccccccc",
      authorizationCohortDigest: "dddddddddddddddd",
    };
    return {
      schemaVersion: 2 as const,
    identityProfile: "modern-contract" as const,
      lineageId,
      rootTransactionId: rootId,
      rootIdentityDigest: computeTreasuryGenerationRootIdentityDigest(rootIdentity),
      generation: 0,
      transactionId: rootId,
      digest: "1111111111111111",
      durableIdentityDigest: "2222222222222222",
      contractDigest: "cccccccccccccccc",
      authorizationCohortDigest: "dddddddddddddddd",
      authorityClass: "identity-bound",
      resolution: "not_executed",
      retirement: { lineagePublished: true, authorityReleased: true, markerCleaned: true },
      completedAtTick: Game.time,
    };
  }

  /** 真实 lineageId 派生（rootTransactionId + rootIdentityDigest canonical）。 */
  function derivedLineageIdOf(rootId: string, rootIdentityDigest: string): string {
    const { hashTreasuryCanonicalString } = require("@/runtime/treasury/transactionId") as typeof import("@/runtime/treasury/transactionId");
    return hashTreasuryCanonicalString(`treasury-attempt-lineage@v1:${rootId}:${rootIdentityDigest}`);
  }

  it("合法 identity-bound modern proof → 写入", () => {
    const rootId = "r21_gr_mod";
    const lineageId = derivedLineageIdOf(rootId, computeTreasuryGenerationRootIdentityDigest({ digest: "1111111111111111", durableIdentityDigest: "2222222222222222", contractDigest: "cccccccccccccccc", authorizationCohortDigest: "dddddddddddddddd" }));
    expect(persistTreasuryGenerationRetirementProof(modernProofOf(rootId, lineageId)).status).toBe("written");
  });

  it("identity-bound 缺 durable → 拒绝", () => {
    const rootId = "r21_gr_nd";
    const lineageId = derivedLineageIdOf(rootId, computeTreasuryGenerationRootIdentityDigest({ digest: "1111111111111111" }));
    const proof: TreasuryGenerationRetirementProof = { ...modernProofOf(rootId, lineageId), durableIdentityDigest: undefined } as never;
    const result = persistTreasuryGenerationRetirementProof(proof);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.detail).toContain("durable");
  });

  it("modern 来源缺 contract / 缺 cohort / 只有其一 → 拒绝", () => {
    const base = modernProofOf("r21_gr_nc", "1111111111111111".padEnd(0));
    void base;
    const rootA = "r21_gr_nc";
    const digestA = computeTreasuryGenerationRootIdentityDigest({ digest: "1111111111111111", durableIdentityDigest: "2222222222222222", contractDigest: "cccccccccccccccc", authorizationCohortDigest: "dddddddddddddddd" });
    const lineageA = derivedLineageIdOf(rootA, digestA);
    const noContract = { ...modernProofOf(rootA, lineageA), contractDigest: undefined } as never as TreasuryGenerationRetirementProof;
    expect(persistTreasuryGenerationRetirementProof(noContract).status).toBe("rejected");
    const noCohort = { ...modernProofOf(rootA, lineageA), authorizationCohortDigest: undefined } as never as TreasuryGenerationRetirementProof;
    expect(persistTreasuryGenerationRetirementProof(noCohort).status).toBe("rejected");
    // rootIdentityDigest 口径也需不含被删除的维度（否则 root 绑定先拒绝——两条路径都 fail closed）。
    const rootB = "r21_gr_nb";
    const digestB = computeTreasuryGenerationRootIdentityDigest({ digest: "1111111111111111", durableIdentityDigest: "2222222222222222" });
    const lineageB = derivedLineageIdOf(rootB, digestB);
    const contractOnly = { ...lowlevelProofOf(rootB, lineageB), contractDigest: "cccccccccccccccc", authorityClass: "lowlevel" } as never as TreasuryGenerationRetirementProof;
    // lowlevel + contract → class 矛盾拒绝。
    expect(persistTreasuryGenerationRetirementProof(contractOnly).status).toBe("rejected");
  });

  it("identity-bound 携带 lowlevelSource → 拒绝", () => {
    const rootId = "r21_gr_llc";
    const digest = computeTreasuryGenerationRootIdentityDigest({ digest: "1111111111111111", durableIdentityDigest: "2222222222222222", contractDigest: "cccccccccccccccc", authorizationCohortDigest: "dddddddddddddddd" });
    const lineageId = derivedLineageIdOf(rootId, digest);
    const proof = { ...modernProofOf(rootId, lineageId), lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME } as never as TreasuryGenerationRetirementProof;
    const result = persistTreasuryGenerationRetirementProof(proof);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.detail).toContain("lowlevelSource");
  });

  it("合法 lowlevel proof → 写入；lowlevel 缺 durable / 缺 source / 携带 contract → 拒绝", () => {
    const rootId = "r21_gr_ok";
    const digest = computeTreasuryGenerationRootIdentityDigest({ digest: "1111111111111111", durableIdentityDigest: "2222222222222222" });
    const lineageId = derivedLineageIdOf(rootId, digest);
    expect(persistTreasuryGenerationRetirementProof(lowlevelProofOf(rootId, lineageId)).status).toBe("written");
    const noDurable = { ...lowlevelProofOf("r21_gr_ndl", derivedLineageIdOf("r21_gr_ndl", computeTreasuryGenerationRootIdentityDigest({ digest: "1111111111111111" }))), durableIdentityDigest: undefined } as never as TreasuryGenerationRetirementProof;
    expect(persistTreasuryGenerationRetirementProof(noDurable).status).toBe("rejected");
    const noSource = { ...lowlevelProofOf("r21_gr_nsl", derivedLineageIdOf("r21_gr_nsl", computeTreasuryGenerationRootIdentityDigest({ digest: "1111111111111111", durableIdentityDigest: "2222222222222222" }))), lowlevelSource: undefined } as never as TreasuryGenerationRetirementProof;
    expect(persistTreasuryGenerationRetirementProof(noSource).status).toBe("rejected");
    const withContract = { ...lowlevelProofOf("r21_gr_wcl", derivedLineageIdOf("r21_gr_wcl", computeTreasuryGenerationRootIdentityDigest({ digest: "1111111111111111", durableIdentityDigest: "2222222222222222" }))), contractDigest: "cccccccccccccccc" } as never as TreasuryGenerationRetirementProof;
    const result = persistTreasuryGenerationRetirementProof(withContract);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.detail).toContain("class");
  });

  it("lineageId 与 (rootTransactionId, rootIdentityDigest) 派生不一致 → 拒绝（root 绑定）", () => {
    const rootId = "r21_gr_bind";
    const proof = lowlevelProofOf(rootId, "0123456789abcdef");
    const result = persistTreasuryGenerationRetirementProof(proof);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.detail).toContain("root 绑定");
  });

  it("duplicate transactionId（不同 lineage / 不同 generation）→ 写入拒绝", () => {
    const rootA = "r21_gr_dup";
    const digestA = computeTreasuryGenerationRootIdentityDigest({ digest: "1111111111111111", durableIdentityDigest: "2222222222222222" });
    const lineageA = derivedLineageIdOf(rootA, digestA);
    expect(persistTreasuryGenerationRetirementProof(lowlevelProofOf(rootA, lineageA)).status).toBe("written");
    // 同 root ID、不同 rootIdentityDigest → 不同 lineage，同 transactionId → 全局唯一拒绝。
    const digestB = computeTreasuryGenerationRootIdentityDigest({ digest: "abababababababab", durableIdentityDigest: "2222222222222222" });
    const lineageB = derivedLineageIdOf(rootA, digestB);
    const duplicate = { ...lowlevelProofOf(rootA, lineageB), digest: "abababababababab", rootIdentityDigest: digestB };
    const result = persistTreasuryGenerationRetirementProof(duplicate);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.detail).toContain("全局唯一");
    // 不同 generation 的同 transactionId 也拒绝（gen1 child ID 复用 root ID）。
    const gen1Duplicate = {
      ...lowlevelProofOf(rootA, lineageA),
      generation: 1,
      transactionId: rootA,
    } as never as TreasuryGenerationRetirementProof;
    expect(persistTreasuryGenerationRetirementProof(gen1Duplicate).status).toBe("rejected");
  });

  it("global reset load 遇重复 transactionId → 整 store unhealthy", () => {
    const rootA = "r21_gr_load";
    const digestA = computeTreasuryGenerationRootIdentityDigest({ digest: "1111111111111111", durableIdentityDigest: "2222222222222222" });
    const lineageA = derivedLineageIdOf(rootA, digestA);
    expect(persistTreasuryGenerationRetirementProof(lowlevelProofOf(rootA, lineageA)).status).toBe("written");
    // 手塞第二条同 transactionId 的 entry（绕过写入检查——构造持久层矛盾）。
    const digestB = computeTreasuryGenerationRootIdentityDigest({ digest: "abababababababab", durableIdentityDigest: "2222222222222222" });
    const lineageB = derivedLineageIdOf(rootA, digestB);
    const store = grStoreOf();
    store.entries[`gr:${lineageB}:000000`] = { ...lowlevelProofOf(rootA, lineageB), digest: "abababababababab", rootIdentityDigest: digestB };
    store.entryCount = Object.keys(store.entries).length;
    resetTreasuryGenerationRetirementRuntimeForTest();
    const health = peekTreasuryGenerationRetirementHealth();
    expect(health.healthy).toBe(false);
    if (!health.healthy) expect(health.detail).toContain("transactionId 重复");
  });

  it("byAttempt 查询直接命中索引（O(1)——fullScans 不随查询增加）", () => {
    const rootId = "r21_gr_idx";
    const digest = computeTreasuryGenerationRootIdentityDigest({ digest: "1111111111111111", durableIdentityDigest: "2222222222222222" });
    const lineageId = derivedLineageIdOf(rootId, digest);
    expect(persistTreasuryGenerationRetirementProof(lowlevelProofOf(rootId, lineageId)).status).toBe("written");
    resetTreasuryGenerationRetirementRuntimeForTest();
    const scansBefore = generationRetirementEvents.fullScans;
    for (let i = 0; i < 50; i += 1) {
      expect(lookupTreasuryGenerationRetirementProofByAttemptId(rootId)).toBeDefined();
    }
    expect(generationRetirementEvents.fullScans).toBe(scansBefore + 1);
    expect(readTreasuryGenerationRetirementProof(lineageId, 0)).toBeDefined();
    expect(validateTreasuryLowlevelSourceField(TREASURY_LOWLEVEL_SOURCE_RUNTIME)).toBeNull();
  });
});
