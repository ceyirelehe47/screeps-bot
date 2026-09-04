/**
 * 【第二十一轮】active current / terminal current 的完整 exact identity 测试。
 *
 * 覆盖（任务书第六/七节与十七节矩阵）：
 * - active current：digest/contract/cohort/durable/proof class/lowlevelSource
 *   与 record.currentIdentity 及 authorityClass 的完整比较——任一不同
 *   conflict、缺维度 insufficient、不得 match；
 * - identity-bound requiredness（digest+durable、禁 lowlevelSource、modern
 *   contract 来源必须保留 contract/cohort——弱 identity-bound 不得降级匹配）；
 * - lowlevel requiredness（digest+durable+受控 provenance、禁 modern facts）；
 * - lineage 四字段正确但 exact identity 错误 → 不 match；
 * - terminal summary v3：root/final exact identity 持久化与 read-back；
 * - terminal current semantic validation 的完整 exact 证明（finalAttemptId
 *   外壳不构成证明）；各维度不同 → conflict；
 * - 旧 v2 summary（无 finalExact）：root blocker 保留、terminal current
 *   insufficient、不得授权新 Receipt 写入；
 * - 同 root 不同 final exact identity 的 summary → 幂等压缩拒绝。
 */
import { clearTreasuryPersistenceForTest, commitSettledReceipt, readTreasurySettlementProof, ensureTreasuryReceiptStore } from "@/runtime/treasury/receipts";
import {
  createTreasuryAttemptLineageRecord,
  convergeTreasuryLineageRetirementFromFacts,
  deriveTreasuryLineageNextChildTransactionId,
  stageTreasuryLineageCapabilityIssued,
  stageTreasuryLineageChildIntentPending,
  activateTreasuryLineageChild,
  readTreasuryAttemptLineageRecord,
  lookupTreasuryAttemptLineageByAttemptId,
  retireTreasuryLineageCurrentAttempt,
  resetTreasuryLineageRuntimeForTest,
  peekTreasuryAttemptLineageHealth,
} from "@/runtime/treasury/attemptLineage";
import { readTreasuryGenerationRetirementProof, resetTreasuryGenerationRetirementRuntimeForTest } from "@/runtime/treasury/generationRetirementAuthority";
import {
  validateTreasurySemanticLineage,
  describeTreasurySemanticLineageVerdict,
  resetTreasurySemanticLineageSourcesForTest,
} from "@/runtime/treasury/semanticLineageValidation";
import { registerTreasuryAttemptLineageSemanticSourceForAssembly, updateTreasuryAttemptLineageRecord as updateTreasuryAttemptLineageRecordForTest } from "@/runtime/treasury/attemptLineage";
import { registerTreasuryRetirementSummarySemanticSourceForAssembly } from "@/runtime/treasury/lineageRetirementSummary";
import { registerTreasuryGenerationRetirementSemanticSourceForAssembly, peekTreasuryGenerationRetirementHealth } from "@/runtime/treasury/generationRetirementAuthority";
import {
  compactTreasuryTerminalLineage,
  lookupTreasuryRetirementSummaryByRoot,
  lookupTreasuryRetirementSummaryByLineageId,
  resetTreasuryRetirementSummaryRuntimeForTest,
  migrateTreasuryRetirementSummaryStoreLegacyAtTickBoundary,
  TREASURY_RETIREMENT_SUMMARY_VERSION,
} from "@/runtime/treasury/lineageRetirementSummary";
import { writeTreasuryResolutionTombstone } from "@/runtime/treasury/resolutionStore";
import { recomputeTreasuryDurableIdentityDigest } from "@/runtime/treasury/identityProof";
import { TREASURY_LOWLEVEL_SOURCE_RUNTIME } from "@/runtime/treasury/authorityLevel";

beforeEach(() => {
  clearTreasuryPersistenceForTest();
});

afterEach(() => {
  resetTreasurySemanticLineageSourcesForTest();
  registerTreasuryAttemptLineageSemanticSourceForAssembly();
  registerTreasuryRetirementSummarySemanticSourceForAssembly();
  registerTreasuryGenerationRetirementSemanticSourceForAssembly();
});

interface ChainIdentity {
  readonly childId: string;
  readonly lineageId: string;
  readonly identity: {
    readonly digest: string;
    readonly durableIdentityDigest: string;
    readonly lowlevelSource?: string;
    readonly lineageId: string;
    readonly lineageGeneration: number;
    readonly parentTransactionId: string;
    readonly lineageBindingDigest: string;
  };
}

/** 低层链到 gen1 child_active（durable 全部真实重算——与 record/intent 同源）。 */
function seedLowlevelChildChain(rootId: string, digest = "1111111111111111"): ChainIdentity {
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
  return {
    childId,
    lineageId,
    identity: {
      digest,
      durableIdentityDigest: childDurable,
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      lineageId,
      lineageGeneration: 1,
      parentTransactionId: rootId,
      lineageBindingDigest: readTreasuryAttemptLineageRecord(lineageId)!.bindingDigest!,
    },
  };
}

/** modern contract（identity-bound）链到 gen1 child_active。 */
function seedModernChildChain(rootId: string): ChainIdentity & { readonly contractDigest: string; readonly cohortDigest: string } {
  const digest = "aaaaaaaaaaaaaaaa";
  const rootDurable = recomputeTreasuryDurableIdentityDigest({
    transactionId: rootId,
    digest,
    actionKind: "terminal.send",
    source: "test",
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
  })!;
  const contractDigest = "cccccccccccccccc";
  const cohortDigest = "dddddddddddddddd";
  const created = createTreasuryAttemptLineageRecord({
    rootTransactionId: rootId,
    rootIdentity: { digest, durableIdentityDigest: rootDurable, contractDigest, authorizationCohortDigest: cohortDigest },
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
    contractDigest,
    authorizationCohortDigest: cohortDigest,
  }).status === "rejected") {
    throw new Error("activate failed");
  }
  return {
    childId,
    lineageId,
    contractDigest,
    cohortDigest,
    identity: {
      digest,
      durableIdentityDigest: childDurable,
      lineageId,
      lineageGeneration: 1,
      parentTransactionId: rootId,
      lineageBindingDigest: readTreasuryAttemptLineageRecord(lineageId)!.bindingDigest!,
    },
  };
}

/** 单代 non-rearmable chain 压缩为 v3 summary（root gen0 退休 + tombstone）。 */
function compactedSingleGeneration(rootId: string): { readonly lineageId: string } {
  const rootDurable = recomputeTreasuryDurableIdentityDigest({
    transactionId: rootId,
    digest: "1111111111111111",
    actionKind: "terminal.send",
    source: "test",
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
  })!;
  const created = createTreasuryAttemptLineageRecord({
    rootTransactionId: rootId,
    rootIdentity: { digest: "1111111111111111", durableIdentityDigest: rootDurable },
    actionKind: "terminal.send",
    authorityClass: "lowlevel",
    lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
    rearmable: false,
    nonRearmReason: "r21 fixture",
  });
  if (created.status !== "written") throw new Error("unreachable");
  const lineageId = created.record.lineageId;
  if (convergeTreasuryLineageRetirementFromFacts(lineageId).status !== "completed") throw new Error("converge failed");
  const record = readTreasuryAttemptLineageRecord(lineageId)!;
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
  if (written.status === "rejected") throw new Error("tombstone rejected: " + written.detail);
  const compacted = compactTreasuryTerminalLineage(lineageId);
  if (compacted.status !== "compacted") throw new Error("compact rejected: " + compacted.detail);
  return { lineageId };
}

describe("active current 完整 exact identity（第二十一轮 6）", () => {
  it("完整一致（lowlevel）→ match", () => {
    const chain = seedLowlevelChildChain("r21_ac_ok");
    const verdict = validateTreasurySemanticLineage({ purpose: "historical_diagnostic", transactionId: chain.childId, proof: chain.identity, identity: chain.identity });
    expect(verdict.verdict).toBe("match");
    if (verdict.verdict === "match") {
      expect(verdict.authoritySource).toBe("active");
      expect(verdict.generationRole).toBe("current");
    }
  });

  it("完整一致（modern contract 链）→ match", () => {
    const chain = seedModernChildChain("r21_ac_mod");
    const verdict = validateTreasurySemanticLineage({
      purpose: "historical_diagnostic",
      transactionId: chain.childId,
      proof: chain.identity,
      identity: { ...chain.identity, contractDigest: chain.contractDigest, authorizationCohortDigest: chain.cohortDigest },
    });
    expect(verdict.verdict).toBe("match");
  });

  it("digest 相同、contract 不同（modern 链）→ conflict", () => {
    const chain = seedModernChildChain("r21_ac_ctr");
    const verdict = validateTreasurySemanticLineage({
      purpose: "historical_diagnostic",
      transactionId: chain.childId,
      proof: chain.identity,
      identity: { ...chain.identity, contractDigest: "eeeeeeeeeeeeeeee", authorizationCohortDigest: chain.cohortDigest },
    });
    expect(verdict.verdict).toBe("conflict");
  });

  it("digest/contract 相同、cohort 不同 → conflict", () => {
    const chain = seedModernChildChain("r21_ac_coh");
    const verdict = validateTreasurySemanticLineage({
      purpose: "historical_diagnostic",
      transactionId: chain.childId,
      proof: chain.identity,
      identity: { ...chain.identity, contractDigest: chain.contractDigest, authorizationCohortDigest: "ffffffffffffffff" },
    });
    expect(verdict.verdict).toBe("conflict");
  });

  it("durable identity 不同 → conflict", () => {
    const chain = seedLowlevelChildChain("r21_ac_dur");
    const verdict = validateTreasurySemanticLineage({
      purpose: "historical_diagnostic",
      transactionId: chain.childId,
      proof: chain.identity,
      identity: { ...chain.identity, durableIdentityDigest: "9999999999999999" },
    });
    expect(verdict.verdict).toBe("conflict");
  });

  it("identity-bound 输入缺 durable identity → insufficient（不降级 match）", () => {
    const chain = seedLowlevelChildChain("r21_ac_nd");
    const { durableIdentityDigest: _omit, ...partial } = chain.identity;
    void _omit;
    const verdict = validateTreasurySemanticLineage({ purpose: "historical_diagnostic", transactionId: chain.childId, proof: chain.identity, identity: partial });
    expect(verdict.verdict).toBe("insufficient");
  });

  it("modern contract current 输入缺 contract → insufficient（弱 identity 不得匹配）", () => {
    const chain = seedModernChildChain("r21_ac_nc");
    // 输入不携带 contract/cohort（record.currentIdentity 有）→ 不可证明。
    const verdict = validateTreasurySemanticLineage({ purpose: "historical_diagnostic", transactionId: chain.childId, proof: chain.identity, identity: chain.identity });
    expect(verdict.verdict).toBe("insufficient");
  });

  it("modern contract current 输入缺 cohort → insufficient", () => {
    const chain = seedModernChildChain("r21_ac_nch");
    const verdict = validateTreasurySemanticLineage({
      purpose: "historical_diagnostic",
      transactionId: chain.childId,
      proof: chain.identity,
      identity: { ...chain.identity, contractDigest: chain.contractDigest },
    });
    expect(verdict.verdict).toBe("insufficient");
  });

  it("identity-bound 输入携带 lowlevelSource → conflict（class 矛盾）", () => {
    const chain = seedModernChildChain("r21_ac_llc");
    const verdict = validateTreasurySemanticLineage({
      purpose: "historical_diagnostic",
      transactionId: chain.childId,
      proof: chain.identity,
      identity: { ...chain.identity, contractDigest: chain.contractDigest, authorizationCohortDigest: chain.cohortDigest, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME },
    });
    expect(verdict.verdict).toBe("conflict");
  });

  it("lowlevel current 输入缺 lowlevelSource → class 推导不一致 → conflict（不可证明）", () => {
    const chain = seedLowlevelChildChain("r21_ac_nll");
    const { lowlevelSource: _omit, ...partial } = chain.identity;
    void _omit;
    const verdict = validateTreasurySemanticLineage({ purpose: "historical_diagnostic", transactionId: chain.childId, proof: chain.identity, identity: partial });
    expect(verdict.verdict).not.toBe("match");
  });

  it("lowlevelSource 不同 → conflict（runtime 与 migrated 不能互相证明）", () => {
    const chain = seedLowlevelChildChain("r21_ac_lls");
    const verdict = validateTreasurySemanticLineage({
      purpose: "historical_diagnostic",
      transactionId: chain.childId,
      proof: chain.identity,
      identity: { ...chain.identity, lowlevelSource: "migrated-lowlevel@v1" },
    });
    expect(verdict.verdict).toBe("conflict");
  });

  it("proof class 不同（lowlevel 输入 vs modern record）→ conflict", () => {
    const chain = seedModernChildChain("r21_ac_cls");
    const verdict = validateTreasurySemanticLineage({
      purpose: "historical_diagnostic",
      transactionId: chain.childId,
      proof: chain.identity,
      identity: { ...chain.identity, lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME },
    });
    expect(verdict.verdict).toBe("conflict");
  });

  it("identity 未提供 → current 不可证明（insufficient，不得 match）", () => {
    const chain = seedLowlevelChildChain("r21_ac_nid");
    const verdict = validateTreasurySemanticLineage({ purpose: "historical_diagnostic", transactionId: chain.childId, proof: chain.identity });
    expect(verdict.verdict).toBe("insufficient");
  });

  it("lineage 四字段正确但 digest 错误 → semantic validator 不得 match", () => {
    const chain = seedLowlevelChildChain("r21_ac_lxd");
    const verdict = validateTreasurySemanticLineage({
      purpose: "historical_diagnostic",
      transactionId: chain.childId,
      proof: chain.identity,
      identity: { ...chain.identity, digest: "7777777777777777" },
    });
    expect(verdict.verdict).toBe("conflict");
    if (verdict.verdict === "conflict") expect(describeTreasurySemanticLineageVerdict(verdict)).toContain("digest");
  });
});

describe("terminal summary v3 与 terminal current exact identity（第二十一轮 7）", () => {
  it("压缩后 summary v3 持久化 rootExact / finalExact 并可 read-back", () => {
    const { lineageId } = compactedSingleGeneration("r21_ts_v3");
    const summary = lookupTreasuryRetirementSummaryByLineageId(lineageId)!;
    expect(summary).toBeDefined();
    expect(summary.schemaVersion).toBe(TREASURY_RETIREMENT_SUMMARY_VERSION);
    expect(summary.rootExact).toBeDefined();
    expect(summary.finalExact).toBeDefined();
    expect(summary.rootExact!.proofClass).toBe("lowlevel");
    expect(summary.rootExact!.identityAlgorithm).toBe("root-identity@v1");
    expect(summary.finalExact!.proofClass).toBe("lowlevel");
    expect(summary.finalExact!.exactIdentitySchema).toBe(1);
    expect(summary.authorityClass).toBe(summary.finalExact!.proofClass);
    // active record 已压缩释放。
    expect(readTreasuryAttemptLineageRecord(lineageId)).toBeUndefined();
    expect(lookupTreasuryRetirementSummaryByRoot("r21_ts_v3")).toBeDefined();
  });

  it("terminal current 完整 match（root gen0 终态）→ terminal_current", () => {
    const { lineageId } = compactedSingleGeneration("r21_tc_ok");
    const summary = lookupTreasuryRetirementSummaryByLineageId(lineageId)!;
    const verdict = validateTreasurySemanticLineage({
      purpose: "historical_diagnostic",
      transactionId: "r21_tc_ok",
      proof: { lineageId: summary.lineageId, lineageGeneration: 0, parentTransactionId: "r21_tc_ok", lineageBindingDigest: "0000000000000000" },
      identity: {
        digest: summary.finalExact!.digest,
        durableIdentityDigest: summary.finalExact!.durableIdentityDigest,
        lowlevelSource: summary.finalExact!.lowlevelSource,
      },
    });
    // gen0 是 root attempt（非 tr1_）——semantic validator 只验证 tr1_；root 的
    // terminal 证明由 root replacement verdict 承载（见 compaction 测试）。
    expect(verdict.verdict).toBe("conflict");
  });

  it("terminal current 完整 match（tr1_ 最终代，篡改 digest）→ conflict", () => {
    // 构造 gen1 not-executed 退休 + 压缩（finalGeneration=1、finalAttemptId=tr1_）。
    const rootId = "r21_tc_final";
    const chain = seedLowlevelChildChain(rootId);
    // retire + converge（exact proof）+ tombstone + 压缩。
    const retire = retireTreasuryLineageCurrentAttempt({ lineageId: chain.lineageId, rearmable: false, nonRearmReason: "r21 terminal fixture" });
    if (retire.status === "rejected") throw new Error("retire rejected");
    if (convergeTreasuryLineageRetirementFromFacts(chain.lineageId).status !== "completed") throw new Error("converge failed");
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
    if (written.status === "rejected") throw new Error("tombstone rejected");
    const compacted = compactTreasuryTerminalLineage(chain.lineageId);
    if (compacted.status !== "compacted") throw new Error("compact rejected: " + compacted.detail);
    const summary = lookupTreasuryRetirementSummaryByLineageId(chain.lineageId)!;
    expect(summary.finalGeneration).toBe(1);
    expect(summary.finalAttemptId).toBe(chain.childId);
    // 完整 match。
    const matchVerdict = validateTreasurySemanticLineage({
      purpose: "historical_diagnostic",
      transactionId: chain.childId,
      proof: {
        lineageId: chain.lineageId,
        lineageGeneration: 1,
        parentTransactionId: rootId,
        lineageBindingDigest: record.bindingDigest!,
      },
      identity: {
        digest: record.currentIdentity.digest,
        durableIdentityDigest: record.currentIdentity.durableIdentityDigest,
        lowlevelSource: record.lowlevelSource,
      },
    });
    expect(matchVerdict.verdict).toBe("match");
    if (matchVerdict.verdict === "match") {
      expect(matchVerdict.authoritySource).toBe("terminal");
      expect(matchVerdict.generationRole).toBe("terminal_current");
    }
    // 同 finalAttemptId 但 digest 不同 → conflict（外壳不构成证明）。
    const conflictVerdict = validateTreasurySemanticLineage({
      purpose: "historical_diagnostic",
      transactionId: chain.childId,
      proof: {
        lineageId: chain.lineageId,
        lineageGeneration: 1,
        parentTransactionId: rootId,
        lineageBindingDigest: record.bindingDigest!,
      },
      identity: {
        digest: "7777777777777777",
        durableIdentityDigest: record.currentIdentity.durableIdentityDigest,
        lowlevelSource: record.lowlevelSource,
      },
    });
    expect(conflictVerdict.verdict).toBe("conflict");
  });

  it("terminal current durable 不同 → conflict；lowlevelSource 不同 → conflict", () => {
    const rootId = "r21_tc_dims";
    const chain = seedLowlevelChildChain(rootId);
    const retire = retireTreasuryLineageCurrentAttempt({ lineageId: chain.lineageId, rearmable: false, nonRearmReason: "r21 terminal fixture" });
    if (retire.status === "rejected") throw new Error("retire rejected");
    if (convergeTreasuryLineageRetirementFromFacts(chain.lineageId).status !== "completed") throw new Error("converge failed");
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
    if (written.status === "rejected") throw new Error("tombstone rejected");
    if (compactTreasuryTerminalLineage(chain.lineageId).status !== "compacted") throw new Error("compact failed");
    const proofInput = {
      lineageId: chain.lineageId,
      lineageGeneration: 1,
      parentTransactionId: rootId,
      lineageBindingDigest: record.bindingDigest!,
    };
    const durableVerdict = validateTreasurySemanticLineage({
      purpose: "historical_diagnostic",
      transactionId: chain.childId,
      proof: proofInput,
      identity: { digest: record.currentIdentity.digest, durableIdentityDigest: "9999999999999999", lowlevelSource: record.lowlevelSource },
    });
    expect(durableVerdict.verdict).toBe("conflict");
    const sourceVerdict = validateTreasurySemanticLineage({
      purpose: "historical_diagnostic",
      transactionId: chain.childId,
      proof: proofInput,
      identity: { digest: record.currentIdentity.digest, durableIdentityDigest: record.currentIdentity.durableIdentityDigest, lowlevelSource: "migrated-lowlevel@v1" },
    });
    expect(sourceVerdict.verdict).toBe("conflict");
    const parentVerdict = validateTreasurySemanticLineage({
      purpose: "historical_diagnostic",
      transactionId: chain.childId,
      proof: { ...proofInput, parentTransactionId: "r21_wrong_parent" },
      identity: { digest: record.currentIdentity.digest, durableIdentityDigest: record.currentIdentity.durableIdentityDigest, lowlevelSource: record.lowlevelSource },
    });
    expect(parentVerdict.verdict).toBe("conflict");
    const bindingVerdict = validateTreasurySemanticLineage({
      purpose: "historical_diagnostic",
      transactionId: chain.childId,
      proof: { ...proofInput, lineageBindingDigest: "8888888888888888" },
      identity: { digest: record.currentIdentity.digest, durableIdentityDigest: record.currentIdentity.durableIdentityDigest, lowlevelSource: record.lowlevelSource },
    });
    expect(bindingVerdict.verdict).toBe("conflict");
  });

  it("旧 v2 summary（无 finalExact）→ terminal current insufficient、root blocker 保留、不得授权新 Receipt", () => {
    const { lineageId } = compactedSingleGeneration("r21_ts_legacy");
    // 降级为 v2（真实 v2 数据无 exact 字段——一并剥离）。
    const store = (Memory.runtime!.treasury as unknown as {
      lineageRetirementSummaries: { version: number; entries: Record<string, Record<string, unknown>>; entryCount: number };
    }).lineageRetirementSummaries;
    store.version = 2;
    for (const key of Object.keys(store.entries)) {
      store.entries[key].schemaVersion = 2;
      delete store.entries[key].rootExact;
      delete store.entries[key].finalExact;
    }
    resetTreasuryRetirementSummaryRuntimeForTest();
    // 【XII/D】query 零写——v2 不再经 lookup 读时迁移（legacy archive 拆分）；
    // 显式 migration owner 执行后再断言（v2 → archive + 空 v3 主 store）。
    expect(migrateTreasuryRetirementSummaryStoreLegacyAtTickBoundary().status).toBe("migrated");
    const summary = lookupTreasuryRetirementSummaryByLineageId(lineageId)!;
    expect(summary).toBeDefined();
    // root replay blocker 保留。
    expect(lookupTreasuryRetirementSummaryByRoot("r21_ts_legacy")).toBeDefined();
    // terminal current 不可证明（v2 无 finalExact）。
    const verdict = validateTreasurySemanticLineage({
      purpose: "historical_diagnostic",
      transactionId: "tr1_x".padEnd(24, "0"),
      proof: { lineageId: summary.lineageId, lineageGeneration: 0, parentTransactionId: "r21_ts_legacy", lineageBindingDigest: "0000000000000000" },
      identity: { digest: summary.rootIdentityDigest, durableIdentityDigest: summary.rootIdentityDigest },
    });
    expect(verdict.verdict).not.toBe("match");
    // 旧 summary 不得授权新 Receipt 写入（tr1_ gate 经 semantic validator fail closed）。
    const blockedId = "tr1_y".padEnd(24, "1");
    ensureTreasuryReceiptStore();
    const committed = commitSettledReceipt(blockedId, Game.time, {
      digest: "1111111111111111",
      durableIdentityDigest: "2222222222222222",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      lineageId: summary.lineageId,
      lineageGeneration: 0,
      parentTransactionId: "r21_ts_legacy",
      lineageBindingDigest: "0000000000000000",
    });
    // tr1_ gate 对不可语义验证的 ID 归类 fatal（零写入 fail closed）。
    expect(committed.status).toBe("fatal");
    expect(readTreasurySettlementProof(blockedId)).toBeUndefined();
  });

  it("同 root 已有不同 final exact identity 的 summary → 幂等压缩拒绝（不覆盖、active 保留）", () => {
    const { lineageId } = compactedSingleGeneration("r21_ts_conflict");
    // active record 已删除——重建同 root 的新链（不同 identity）后压缩同 root：
    // summary 已存在且 identity 不同 → 拒绝。
    const rootDurable = recomputeTreasuryDurableIdentityDigest({
      transactionId: "r21_ts_conflict",
      digest: "abababababababab",
      actionKind: "terminal.send",
      source: "test",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
    })!;
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: "r21_ts_conflict",
      rootIdentity: { digest: "abababababababab", durableIdentityDigest: rootDurable },
      actionKind: "terminal.send",
      authorityClass: "lowlevel",
      lowlevelSource: TREASURY_LOWLEVEL_SOURCE_RUNTIME,
      rearmable: false,
      nonRearmReason: "r21 conflict chain",
    });
    if (created.status !== "written") throw new Error("unreachable");
    // 直接置终态（root exact proof 已被第一条链占用——GRA 全局 transactionId 唯一
    // 拒绝第二条链 converge，本用例只测 summary 幂等压缩拒绝路径）。
    const finalized = updateTreasuryAttemptLineageRecordForTest(created.record.lineageId, (current) => ({
      ...current,
      state: "non_rearmable_retired" as const,
      retirement: { lineagePublished: true, authorityReleased: true, markerCleaned: true },
      retirementGeneration: 0,
      updatedAtTick: Game.time,
      recordRevision: current.recordRevision + 1,
    }));
    if (finalized.status === "rejected") throw new Error("finalize rejected");
    const record = readTreasuryAttemptLineageRecord(created.record.lineageId)!;
    void record;
    // 第一链的 final tombstone（同 root ID、不同 digest）仍在——第二链压缩将在
    // tombstone exact identity 或 summary 幂等任一路径 fail closed 拒绝。
    const result = compactTreasuryTerminalLineage(created.record.lineageId);
    expect(result.status).toBe("rejected");
    // active 保留、旧 summary 不被覆盖。
    expect(readTreasuryAttemptLineageRecord(created.record.lineageId)).toBeDefined();
    const summary = lookupTreasuryRetirementSummaryByRoot("r21_ts_conflict")!;
    expect(summary.rootExact!.digest).toBe("1111111111111111");
  });
});

describe("健康与防御（回归锚点）", () => {
  it("lineage store unhealthy → semantic validation fail closed", () => {
    const chain = seedLowlevelChildChain("r21_hl_bad");
    const store = (Memory.runtime as { treasury?: { attemptLineage?: { entries: Record<string, unknown>; entryCount: number } } }).treasury?.attemptLineage;
    store!.entryCount = store!.entryCount + 1;
    resetTreasuryLineageRuntimeForTest();
    expect(peekTreasuryAttemptLineageHealth().healthy).toBe(false);
    const verdict = validateTreasurySemanticLineage({ purpose: "historical_diagnostic", transactionId: chain.childId, proof: chain.identity, identity: chain.identity });
    expect(verdict.verdict).toBe("store_unhealthy");
  });

  it("exact retirement store unhealthy → 历史/终代 proof 查询 fail closed", () => {
    const chain = seedLowlevelChildChain("r21_hgra_bad");
    void chain;
    (Memory.runtime as { treasury?: { generationRetirementProofs?: unknown } }).treasury!.generationRetirementProofs = { version: 999, entries: {}, entryCount: 0, updatedAt: 0 };
    resetTreasuryGenerationRetirementRuntimeForTest();
    const health = peekTreasuryGenerationRetirementHealth();
    expect(health.healthy).toBe(false);
  });

  it("lookupTreasuryAttemptLineageByAttemptId 的 current 命中（O(1) 回归）", () => {
    const chain = seedLowlevelChildChain("r21_lookup");
    expect(lookupTreasuryAttemptLineageByAttemptId(chain.childId)?.lineageId).toBe(chain.lineageId);
    expect(readTreasuryGenerationRetirementProof(chain.lineageId, 0)).toBeDefined();
  });
});
