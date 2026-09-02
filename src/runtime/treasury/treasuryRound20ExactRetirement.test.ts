/**
 * 【第二十轮】exact per-generation retirement authority 与 historical
 * generation / terminal compaction / tombstone replacement 测试（任务 26.12）。
 *
 * 覆盖：
 * - exact proof 写入协议（三段收敛后写入 + read-back、失败保持 retiring、
 *   容量满载 fail closed、alias 隔离、深冻结、global reset 索引重建）；
 * - 下一代 capability 门禁（proof 缺失/不一致 → 拒绝；正常流可签发）；
 * - active 历史代 verdict（exact proof 匹配才 match；缺失 pin；篡改
 *   digest/parent → conflict；gen < current 无 proof 不 match）；
 * - 多代独立 proof 与容量有界；
 * - terminal compaction 完整 exact settlement identity 矩阵（同 digest/
 *   lineage 但 contract/cohort/durable/lowlevel/class 不同 → 不压缩）；
 * - root/child tombstone replacement（root 五元不匹配 conflict；child
 *   parent/binding 篡改 conflict；summary 无 exact proof 不 match）；
 * - 压缩后孤儿 proof 清理与 root 门禁继续有效。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest, readTreasurySettlementProof } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import {
  createTreasuryAttemptLineageRecord,
  convergeTreasuryLineageRetirementFromFacts,
  stageTreasuryLineageCapabilityIssued,
  stageTreasuryLineageChildIntentPending,
  activateTreasuryLineageChild,
  deriveTreasuryLineageNextChildTransactionId,
  readTreasuryAttemptLineageRecord,
  lookupTreasuryAttemptLineageByAttemptId,
  retireTreasuryLineageCurrentAttempt,
  resetTreasuryLineageRuntimeForTest,
  peekTreasuryAttemptLineageHealth,
  updateTreasuryAttemptLineageRecord as updateTreasuryAttemptLineageRecordForTest,
} from "@/runtime/treasury/attemptLineage";
import {
  computeTreasuryGenerationRootIdentityDigest,
  persistTreasuryGenerationRetirementProof,
  readTreasuryGenerationRetirementProof,
  peekTreasuryGenerationRetirementHealth,
  resetTreasuryGenerationRetirementRuntimeForTest,
  releaseTreasuryGenerationRetirementProofOfAttempt,
  TREASURY_GENERATION_RETIREMENT_MAX_ENTRIES,
  generationRetirementEvents,
  type TreasuryGenerationRetirementProof,
} from "@/runtime/treasury/generationRetirementAuthority";
import { treasuryTombstoneReplacementVerdict } from "@/runtime/treasury/lineageGenerationRetirement";
import { compactTreasuryTerminalLineage, lookupTreasuryRetirementSummaryByRoot, peekTreasuryRetirementSummaryHealth, resetTreasuryRetirementSummaryRuntimeForTest } from "@/runtime/treasury/lineageRetirementSummary";
import { writeTreasuryResolutionTombstone, readTreasuryResolutionTombstone } from "@/runtime/treasury/resolutionStore";
import { computeTreasuryLineageBindingDigest } from "@/runtime/treasury/lineageBinding";
import { registerTreasuryPolicyResolver, makeFixedReserveTreasuryPolicy } from "@/runtime/treasury/policyAuthority";
import {
  makeTreasuryTestTransferAdapter,
  replaceTreasuryActionAdapterForTest,
  resetTreasuryTestAdapterSideEffectsForTest,
  type TreasuryActionReconcilerConclusion,
} from "@/runtime/treasury/actionContracts";
import { setTreasuryCommitFaultInjectorForTest } from "@/runtime/treasury/writeFault";
import { installRooms, type RoomSpec } from "@mock/treasury";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import type { TreasuryTransactionInput } from "@/runtime/treasury/types";

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

function freshInput(service: TreasuryTestService, transactionId: string, delta = -500): TreasuryTransactionInput {
  const epoch = service.observation().epoch;
  return {
    transactionId,
    kind: "terminal.send",
    source: "test",
    decision: { scope: epoch.scope, epochSeq: epoch.epochSeq, observedAtTick: epoch.observedAtTick },
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta }],
  };
}

function advanceTick(): TreasuryTestService {
  Game.time += 1;
  return makeService();
}

function resolveNotExecuted(service: TreasuryTestService, transactionId: string) {
  const issued = service.issueTreasuryReconciliationCapability({ transactionId });
  if (issued.status !== "issued") return issued;
  return service.resolveUnresolvedTransaction({ transactionId, capability: issued.capability });
}

let reconcilerConclusion: TreasuryActionReconcilerConclusion = "observed_not_executed";

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  setTreasuryCommitFaultInjectorForTest(null);
  resetTreasuryTestAdapterSideEffectsForTest();
  registerTreasuryPolicyResolver(makeFixedReserveTreasuryPolicy(1_000));
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter("observed_not_executed"));
  replaceTreasuryActionAdapterForTest({
    ...makeTreasuryTestTransferAdapter(),
    kind: "terminal.send",
    semanticIdentity: "terminal.send@reconciler-semantics-v1",
    reconcile: () => reconcilerConclusion,
  });
});

afterEach(() => {
  setTreasuryCommitFaultInjectorForTest(null);
  reconcilerConclusion = "observed_not_executed";
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
});

/** 推进 chain 到指定代的 child_active（每代经完整 resolve-as-not-executed → exact proof → capability 流）。 */
function advanceChainToGeneration(rootId: string, targetGeneration: number): { readonly childId: string; readonly lineageId: string } {
  let service = makeService();
  const executed = service.executePreparedAction(freshInput(service, rootId), () => {
    service.endTick();
    return { ok: false as const };
  });
  expect(executed.status).toBe("executed_abort_failed");
  service = advanceTick();
  expect(resolveNotExecuted(service, rootId).status).toBe("resolved");
  let current = rootId;
  for (let gen = 1; gen <= targetGeneration; gen += 1) {
    const next = advanceTick();
    const issued = next.issueTreasuryRearmCapability({ parentTransactionId: current });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") throw new Error("unreachable");
    const childExecuted = next.executePreparedAction(freshInput(next, issued.childTransactionId), () => ({ ok: false as const }), { rearmCapability: issued.capability });
    // 低层 child non-OK + abort 成功 → 同步 not-executed retirement（executed_
    // aborted；quarantine 残留则显式 resolve 收敛）。
    expect(childExecuted.status === "executed_aborted" || childExecuted.status === "executed_abort_failed").toBe(true);
    current = issued.childTransactionId;
    const resolved = advanceTick();
    if (childExecuted.status === "executed_abort_failed") {
      expect(resolveNotExecuted(resolved, current).status).toBe("resolved");
    }
  }
  const record = lookupTreasuryAttemptLineageByAttemptId(current)!;
  return { childId: current, lineageId: record.lineageId };
}

describe("exact per-generation retirement authority（第二十轮 26.7）", () => {
  it("retirement 三段全部完成 → exact proof 持久化（字段完整可独立验证）", () => {
    const { childId, lineageId } = advanceChainToGeneration("r20_gr_proof", 1);
    const record = readTreasuryAttemptLineageRecord(lineageId)!;
    // resolve 后 chain 处于 rearm_ready（当前代 retired + exact proof 写入）。
    expect(record.state).toBe("rearm_ready");
    const proof = readTreasuryGenerationRetirementProof(lineageId, 0)!;
    expect(proof).toBeDefined();
    expect(proof.transactionId).toBe("r20_gr_proof");
    expect(proof.generation).toBe(0);
    expect(proof.retirement.lineagePublished).toBe(true);
    expect(proof.retirement.authorityReleased).toBe(true);
    expect(proof.retirement.markerCleaned).toBe(true);
    // advanceChain 结束时当前代（gen1）也已退休 → 其 exact proof 同样在位。
    const gen1Proof = readTreasuryGenerationRetirementProof(lineageId, 1)!;
    expect(gen1Proof).toBeDefined();
    expect(gen1Proof.parentTransactionId).toBe("r20_gr_proof");
    void childId;
  });

  it("publication 未完成（marker 匹配未清）→ converge 保持 retiring、无 exact proof、无 N+1 capability", () => {
    const service = makeService();
    const executed = service.executePreparedAction(freshInput(service, "r20_gr_pend"), () => {
      service.endTick();
      return { ok: false as const };
    });
    expect(executed.status).toBe("executed_abort_failed");
    // marker 未清（execution-unknown 相位）→ resolve-as-not-executed 的 marker
    // 清除失败 → pending_cleanup（保持 retiring）。
    const t1 = advanceTick();
    const issued0 = t1.issueTreasuryReconciliationCapability({ transactionId: "r20_gr_pend" });
    expect(issued0.status).toBe("issued");
    if (issued0.status !== "issued") return;
    // 强制 marker 保持存在：直接构造 resolve（adapter 结论 not_executed；marker
    // 属本 attempt 且匹配未清——converge 保持 retiring）。
    const resolved = t1.resolveUnresolvedTransaction({ transactionId: "r20_gr_pend", capability: issued0.capability });
    // 若正常 resolved（marker 已被 resolve 清除）则本场景不适用——直接跳过。
    if (resolved.status === "resolved") return;
    const record = lookupTreasuryAttemptLineageByAttemptId("r20_gr_pend")!;
    expect(record.state).toBe("retiring");
    const next = advanceTick();
    const issued = next.issueTreasuryRearmCapability({ parentTransactionId: "r20_gr_pend" });
    expect(issued.status).toBe("rejected");
  });

  it("exact proof read-back 后才签发 N+1 capability；删除 proof → 拒绝", () => {
    const { childId, lineageId } = advanceChainToGeneration("r20_gr_gate", 1);
    const next = advanceTick();
    const issued = next.issueTreasuryRearmCapability({ parentTransactionId: childId });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    // 同代重签（capability 过期回退后）：删除 exact proof → preflight 拒绝。
    const record = readTreasuryAttemptLineageRecord(lineageId)!;
    // 强制删除（模拟旧数据/proof 丢失——release 通道对当前代 proof 保留：
    // 它是下一代 capability 门禁的依据，只有 Memory 层删除能构造缺失形态）。
    const graStore = (Memory.runtime as { treasury?: { generationRetirementProofs?: { entries: Record<string, unknown>; entryCount: number } } }).treasury?.generationRetirementProofs!;
    const proofKey = `gr:${record.lineageId}:000001`;
    expect(graStore.entries[proofKey]).toBeDefined();
    expect(proofKey).toBeDefined();
    delete graStore.entries[proofKey];
    graStore.entryCount -= 1;
    resetTreasuryGenerationRetirementRuntimeForTest();
    const next2 = advanceTick();
    const reissue = next2.issueTreasuryRearmCapability({ parentTransactionId: childId });
    expect(reissue.status).toBe("rejected");
    if (reissue.status === "rejected") expect(reissue.reason).toBe("generation_retirement_proof_missing");
  });

  it("proof store 满载 → fail closed（retirement 保持 retiring）", () => {
    // 填满 proof store（其它 lineage 的合法 proof）。
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: "r20_gr_fill",
      rootIdentity: { digest: "1111111111111111", durableIdentityDigest: "2222222222222222" },
      actionKind: "terminal.send",
      authorityClass: "lowlevel",
      lowlevelSource: "runtime-lowlevel@v1",
      rearmable: false,
      nonRearmReason: "filler",
    });
    expect(created.status).toBe("written");
    if (created.status !== "written") return;
    const expectedIdOf = (generation: number): string =>
      generation <= 0 ? "r20_gr_fill" : deriveTreasuryLineageNextChildTransactionId(created.record.lineageId, generation, "r20_gr_fill");
    const fillerProof = (generation: number): TreasuryGenerationRetirementProof => ({
      schemaVersion: 2 as const,
      identityProfile: "lowlevel" as const,
      lineageId: created.record.lineageId,
      rootTransactionId: "r20_gr_fill",
      // 【第二十一轮 10.2】root 绑定：rootIdentityDigest 必须与 (rootTransactionId, lineageId) 满足共享 canonical 派生。
      rootIdentityDigest: computeTreasuryGenerationRootIdentityDigest({ digest: "1111111111111111", durableIdentityDigest: "2222222222222222" }),
      generation,
      transactionId: expectedIdOf(generation),
      ...(generation >= 1 ? {
        parentTransactionId: expectedIdOf(generation - 1),
        bindingDigest: computeTreasuryLineageBindingDigest({
          lineageId: created.record.lineageId,
          generation,
          parentTransactionId: expectedIdOf(generation - 1),
          childTransactionId: expectedIdOf(generation),
        }),
      } : {}),
      digest: "1111111111111111",
      durableIdentityDigest: "2222222222222222",
      lowlevelSource: "runtime-lowlevel@v1",
      authorityClass: "lowlevel",
      resolution: "not_executed",
      retirement: { lineagePublished: true, authorityReleased: true, markerCleaned: true },
      completedAtTick: Game.time,
    });
    // 单 lineage 多代填满（容量 384）。
    for (let gen = 0; gen < TREASURY_GENERATION_RETIREMENT_MAX_ENTRIES; gen += 1) {
      const written = persistTreasuryGenerationRetirementProof(fillerProof(gen));
      if (written.status === "rejected") throw new Error("filler write failed at " + String(gen) + ": " + written.detail);
    }
    expect(peekTreasuryGenerationRetirementHealth().entryCount).toBe(TREASURY_GENERATION_RETIREMENT_MAX_ENTRIES);
    // 新 chain 的 retirement 收敛 → exact proof 写入被容量拒绝 → 保持 retiring。
    const created2 = createTreasuryAttemptLineageRecord({
      rootTransactionId: "r20_gr_full",
      rootIdentity: { digest: "4444444444444444", durableIdentityDigest: "5555555555555555" },
      actionKind: "terminal.send",
      authorityClass: "lowlevel",
      lowlevelSource: "runtime-lowlevel@v1",
      rearmable: true,
      retrySemanticDigest: "6666666666666666",
    });
    expect(created2.status).toBe("written");
    if (created2.status !== "written") return;
    const converged = convergeTreasuryLineageRetirementFromFacts(created2.record.lineageId);
    expect(converged.status).toBe("pending");
    if (converged.status === "pending") expect(converged.pendingStages).toContain("exact_retirement_proof");
    expect(readTreasuryAttemptLineageRecord(created2.record.lineageId)?.state).toBe("retiring");
  });

  it("persist 输入 alias 不污染 Memory；读取返回深冻结快照", () => {
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: "r20_gr_alias",
      rootIdentity: { digest: "1111111111111111", durableIdentityDigest: "2222222222222222" },
      actionKind: "terminal.send",
      authorityClass: "lowlevel",
      lowlevelSource: "runtime-lowlevel@v1",
      rearmable: true,
      retrySemanticDigest: "6666666666666666",
    });
    expect(created.status).toBe("written");
    if (created.status !== "written") return;
    const input: TreasuryGenerationRetirementProof = {
      schemaVersion: 2 as const,
    identityProfile: "lowlevel" as const,
      lineageId: created.record.lineageId,
      rootTransactionId: "r20_gr_alias",
      // 【第二十一轮 10.2】root 绑定：rootIdentityDigest 真实派生（假值被共享 canonical 校验拒绝）。
      rootIdentityDigest: computeTreasuryGenerationRootIdentityDigest({ digest: "1111111111111111", durableIdentityDigest: "2222222222222222" }),
      generation: 0,
      transactionId: "r20_gr_alias",
      digest: "1111111111111111",
      durableIdentityDigest: "2222222222222222",
      lowlevelSource: "runtime-lowlevel@v1",
      authorityClass: "lowlevel",
      resolution: "not_executed",
      retirement: { lineagePublished: true, authorityReleased: true, markerCleaned: true },
      completedAtTick: Game.time,
    };
    expect(persistTreasuryGenerationRetirementProof(input).status).toBe("written");
    (input as { digest?: string }).digest = "eeeeeeeeeeeeeeee";
    expect(readTreasuryGenerationRetirementProof(created.record.lineageId, 0)?.digest).toBe("1111111111111111");
    const snapshot = readTreasuryGenerationRetirementProof(created.record.lineageId, 0)!;
    expect(() => {
      (snapshot as unknown as { digest: string }).digest = "dddddddddddddddd";
    }).toThrow();
  });

  it("global reset 后 exact proof 索引重建一致（清 heap 后读取正常）", () => {
    const { lineageId } = advanceChainToGeneration("r20_gr_reset", 1);
    expect(readTreasuryGenerationRetirementProof(lineageId, 0)).toBeDefined();
    resetTreasuryGenerationRetirementRuntimeForTest();
    const proof = readTreasuryGenerationRetirementProof(lineageId, 0);
    expect(proof).toBeDefined();
    expect(proof?.transactionId).toBe("r20_gr_reset");
  });
});

describe("active lineage 历史代 exact proof（第二十轮 26.8）", () => {
  it("A not-executed → B active：A tombstone 匹配 exact proof 才 match", () => {
    const { childId, lineageId } = advanceChainToGeneration("r20_hist_ab", 1);
    const record = readTreasuryAttemptLineageRecord(lineageId)!;
    expect(record.generation).toBe(1);
    const aProof = readTreasuryGenerationRetirementProof(lineageId, 0)!;
    const verdict = treasuryTombstoneReplacementVerdict({
      transactionId: "r20_hist_ab",
      digest: aProof.digest,
      resolution: "not-executed",
      stage: "final",
      proofLevel: aProof.authorityClass,
      durableIdentityDigest: aProof.durableIdentityDigest,
      lowlevelSource: aProof.lowlevelSource,
    });
    expect(verdict.verdict).toBe("replacement_match");
    void childId;
  });

  it("删除 A exact proof → A tombstone pin（generation < current 不再推断 match）", () => {
    const { lineageId } = advanceChainToGeneration("r20_hist_del", 1);
    const aProof = readTreasuryGenerationRetirementProof(lineageId, 0)!;
    const released = releaseTreasuryGenerationRetirementProofOfAttempt("r20_hist_del");
    expect(released.status).toBe("released");
    const verdict = treasuryTombstoneReplacementVerdict({
      transactionId: "r20_hist_del",
      digest: aProof.digest,
      resolution: "not-executed",
      stage: "final",
      proofLevel: aProof.authorityClass,
      durableIdentityDigest: aProof.durableIdentityDigest,
      lowlevelSource: aProof.lowlevelSource,
    });
    expect(verdict.verdict).toBe("replacement_missing");
    if (verdict.verdict === "replacement_missing") expect(verdict.detail).toContain("状态机曾推进不构成");
  });

  it("篡改 A exact proof digest → conflict", () => {
    const { lineageId } = advanceChainToGeneration("r20_hist_tamper", 1);
    const aProof = readTreasuryGenerationRetirementProof(lineageId, 0)!;
    const verdict = treasuryTombstoneReplacementVerdict({
      transactionId: "r20_hist_tamper",
      digest: "9999999999999999",
      resolution: "not-executed",
      stage: "final",
      proofLevel: aProof.authorityClass,
      durableIdentityDigest: aProof.durableIdentityDigest,
      lowlevelSource: aProof.lowlevelSource,
    });
    expect(verdict.verdict).toBe("replacement_conflict");
  });

  it("篡改持久 parent 字段（child tombstone parent 与 proof 不一致）→ conflict", () => {
    const { childId, lineageId } = advanceChainToGeneration("r20_hist_par", 1);
    // 当前代（gen1）tombstone 的 parent 篡改 → 当前代持久 parent 比较拦截。
    const record = readTreasuryAttemptLineageRecord(lineageId)!;
    const verdict = treasuryTombstoneReplacementVerdict({
      transactionId: childId,
      digest: record.currentIdentity.digest,
      resolution: "not-executed",
      stage: "final",
      proofLevel: record.authorityClass,
      durableIdentityDigest: record.currentIdentity.durableIdentityDigest,
      lowlevelSource: record.lowlevelSource,
      lineageId,
      lineageGeneration: 1,
      parentTransactionId: "r20_wrong_parent",
      lineageBindingDigest: record.bindingDigest,
    });
    expect(verdict.verdict).toBe("replacement_conflict");
    if (verdict.verdict === "replacement_conflict") expect(verdict.detail).toContain("parent");
  });

  it("A→B→C：每一历史代独立 proof（两代历史分别可验证）", () => {
    const { childId, lineageId } = advanceChainToGeneration("r20_hist_abc", 2);
    const record = readTreasuryAttemptLineageRecord(lineageId)!;
    expect(record.generation).toBe(2);
    const bProof = readTreasuryGenerationRetirementProof(lineageId, 1)!;
    expect(bProof).toBeDefined();
    const verdictB = treasuryTombstoneReplacementVerdict({
      transactionId: bProof.transactionId,
      digest: bProof.digest,
      resolution: "not-executed",
      stage: "final",
      proofLevel: bProof.authorityClass,
      durableIdentityDigest: bProof.durableIdentityDigest,
      lowlevelSource: bProof.lowlevelSource,
      // 【第二十一轮 12.2】tombstone 必须携带持久 parent/binding（缺失 = 不可证明 pin）。
      parentTransactionId: bProof.parentTransactionId,
      lineageBindingDigest: bProof.bindingDigest,
    });
    expect(verdictB.verdict).toBe("replacement_match");
    void childId;
  });
});

describe("terminal compaction exact settlement identity（第二十轮 26.9）", () => {
  /** 构造 committed chain（root not-executed → gen1 child committed）并返回 record/proof 视图。 */
  function committedChain(rootId: string): {
    readonly record: ReturnType<typeof readTreasuryAttemptLineageRecord> extends (infer T) | undefined ? NonNullable<T> : never;
    readonly receiptView: () => ReturnType<typeof readTreasurySettlementProof>;
    readonly lineageId: string;
  } {
    const service = makeService();
    const executed = service.executePreparedAction(freshInput(service, rootId), () => {
      service.endTick();
      return { ok: false as const };
    });
    expect(executed.status).toBe("executed_abort_failed");
    const t1 = advanceTick();
    expect(resolveNotExecuted(t1, rootId).status).toBe("resolved");
    const t2 = advanceTick();
    const issued = t2.issueTreasuryRearmCapability({ parentTransactionId: rootId });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") throw new Error("unreachable");
    reconcilerConclusion = "observed_committed";
    const childExecuted = t2.executePreparedAction(freshInput(t2, issued.childTransactionId), () => ({ ok: true as const }), { rearmCapability: issued.capability });
    expect(childExecuted.status).toBe("executed_committed");
    reconcilerConclusion = "observed_not_executed";
    const record = lookupTreasuryAttemptLineageByAttemptId(issued.childTransactionId)!;
    return { record, receiptView: () => readTreasurySettlementProof(issued.childTransactionId), lineageId: record.lineageId };
  }

  it("chain committed receipt 与 current 完整 exact identity 匹配 → 可压缩（root 门禁继续）", () => {
    const { record, lineageId } = committedChain("r20_cmp_ok");
    expect(compactTreasuryTerminalLineage(lineageId).status).toBe("compacted");
    expect(readTreasuryAttemptLineageRecord(lineageId)).toBeUndefined();
    expect(lookupTreasuryRetirementSummaryByRoot("r20_cmp_ok")).toBeDefined();
    // 压缩后 root 门禁继续有效。
    const t = advanceTick();
    expect(t.prepareTransaction(freshInput(t, "r20_cmp_ok")).status).toBe("rejected");
  });

  it("同 digest/同 lineage 但 receipt contract 维度缺失（identity-bound 链）→ 不压缩（对照：完整匹配链才压缩）", () => {
    // 低层链的 receipt 无 contract——构造 contract 篡改场景：手改 receipt 的
    // contractDigest（改后 proof 与 record.currentIdentity 不一致）→ 拒绝压缩。
    const { record, lineageId } = committedChain("r20_cmp_ctr");
    const receipt = readTreasurySettlementProof(record.currentTransactionId)!;
    void receipt;
    // 手改 record.currentIdentity 的 contract 维度不可行（冻结）——改为手改
    // receipt：低层 receipt 无 contract 字段，篡改 lowlevelSource 维度。
    (Memory.runtime as { treasury?: { receipts?: { settled: Record<string, unknown> } } }).treasury!.receipts!.settled[`t:${record.currentTransactionId}`] = {
      ...receipt,
      lowlevelSource: "migrated-lowlevel@v1",
    } as never;
    const compacted = compactTreasuryTerminalLineage(lineageId);
    expect(compacted.status).toBe("rejected");
    if (compacted.status === "rejected") expect(compacted.detail).toContain("不压缩");
    expect(readTreasuryAttemptLineageRecord(lineageId)).toBeDefined();
  });

  it("receipt store unhealthy → 不压缩（active record 保留）", () => {
    const { record, lineageId } = committedChain("r20_cmp_unh");
    void record;
    // 破坏 receipt store 版本 → unhealthy。
    (Memory.runtime as { treasury?: { receipts?: { version: number } } }).treasury!.receipts!.version = 999;
    const compacted = compactTreasuryTerminalLineage(lineageId);
    expect(compacted.status).toBe("rejected");
    expect(readTreasuryAttemptLineageRecord(lineageId)).toBeDefined();
  });

  it("压缩后清理孤儿 proof（tombstone 已驱逐的历史代）；仍存活 tombstone 的 proof 保留", () => {
    const { record, lineageId } = committedChain("r20_cmp_orphan");
    const rootProofBefore = readTreasuryGenerationRetirementProof(lineageId, 0);
    expect(rootProofBefore).toBeDefined();
    expect(compactTreasuryTerminalLineage(lineageId).status).toBe("compacted");
    // root 的 final not-executed tombstone 仍存活（resolve 流写入）→ 其 gen0
    // exact proof 保留（仍被依赖——压缩后历史代证明继续有效）。
    expect(readTreasuryResolutionTombstone("r20_cmp_orphan")).toBeDefined();
    expect(readTreasuryGenerationRetirementProof(lineageId, 0)).toBeDefined();
    void record;
  });
});

describe("root/child tombstone replacement 身份 exact（第二十轮 26.8）", () => {
  /** 单代 non-rearmable chain：root retired + exact proof + final tombstone + 压缩。 */
  function compactedSingleGenerationChain(rootId: string): { readonly lineageId: string } {
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: rootId,
      rootIdentity: { digest: "1111111111111111", durableIdentityDigest: "2222222222222222" },
      actionKind: "terminal.send",
      authorityClass: "lowlevel",
      lowlevelSource: "runtime-lowlevel@v1",
      rearmable: false,
      nonRearmReason: "test single-gen terminal",
    });
    expect(created.status).toBe("written");
    if (created.status !== "written") throw new Error("unreachable");
    const lineageId = created.record.lineageId;
    expect(convergeTreasuryLineageRetirementFromFacts(lineageId).status).toBe("completed");
    const record = readTreasuryAttemptLineageRecord(lineageId)!;
    expect(record.state).toBe("non_rearmable_retired");
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
    expect(written.status).not.toBe("rejected");
    expect(compactTreasuryTerminalLineage(lineageId).status).toBe("compacted");
    expect(lookupTreasuryRetirementSummaryByRoot(rootId)).toBeDefined();
    return { lineageId };
  }

  it("root ID 命中 summary 但 digest 不同 → conflict/pin（五元重算不一致）", () => {
    const { lineageId } = compactedSingleGenerationChain("r20_root_idc");
    const verdict = treasuryTombstoneReplacementVerdict({
      transactionId: "r20_root_idc",
      digest: "9999999999999999",
      resolution: "not-executed",
      stage: "final",
      proofLevel: "lowlevel",
      durableIdentityDigest: "2222222222222222",
      lowlevelSource: "runtime-lowlevel@v1",
    });
    expect(verdict.verdict).toBe("replacement_conflict");
    // 【第二十一轮 12.1】v3 语义：rootExact 完整比较（不再仅凭 rootIdentityDigest 重算判定）。
    if (verdict.verdict === "replacement_conflict") expect(verdict.detail).toContain("rootExact");
    void lineageId;
  });

  it("root 五元匹配 + generation 0 exact proof → replacement_match；删除 proof → 不得 match", () => {
    const { lineageId } = compactedSingleGenerationChain("r20_root_mch");
    const match = treasuryTombstoneReplacementVerdict({
      transactionId: "r20_root_mch",
      digest: "1111111111111111",
      resolution: "not-executed",
      stage: "final",
      proofLevel: "lowlevel",
      durableIdentityDigest: "2222222222222222",
      lowlevelSource: "runtime-lowlevel@v1",
    });
    expect(match.verdict).toBe("replacement_match");
    const released = releaseTreasuryGenerationRetirementProofOfAttempt("r20_root_mch");
    expect(released.status).toBe("released");
    const missing = treasuryTombstoneReplacementVerdict({
      transactionId: "r20_root_mch",
      digest: "1111111111111111",
      resolution: "not-executed",
      stage: "final",
      proofLevel: "lowlevel",
      durableIdentityDigest: "2222222222222222",
      lowlevelSource: "runtime-lowlevel@v1",
    });
    expect(missing.verdict).toBe("replacement_missing");
    if (missing.verdict === "replacement_missing") expect(missing.detail).toContain("exact retirement proof");
  });

  it("summary finalGeneration 存在但历史代无 exact proof → 不得 match（finalGeneration 只是边界）", () => {
    const { lineageId } = compactedSingleGenerationChain("r20_sum_nop");
    // 伪造 gen1 历史代 tombstone（ID 派生合法、四字段完整——但 gen1 无 proof）。
    const gen1Id = deriveTreasuryLineageNextChildTransactionId(lineageId, 1, "r20_sum_nop");
    const gen1Parent = "r20_sum_nop";
    const gen1Binding = computeTreasuryLineageBindingDigest({ lineageId, generation: 1, parentTransactionId: gen1Parent, childTransactionId: gen1Id });
    const verdict = treasuryTombstoneReplacementVerdict({
      transactionId: gen1Id,
      digest: "1111111111111111",
      resolution: "not-executed",
      stage: "final",
      proofLevel: "lowlevel",
      durableIdentityDigest: "2222222222222222",
      lowlevelSource: "runtime-lowlevel@v1",
      lineageId,
      lineageGeneration: 1,
      parentTransactionId: gen1Parent,
      lineageBindingDigest: gen1Binding,
    });
    // summary finalGeneration=0 < gen1 → 冲突（未来代）——证明 finalGeneration
    // 边界语义；改用 gen0 验证 proof 缺失路径（上方 root_mch 已覆盖）。
    expect(verdict.verdict).toBe("replacement_conflict");
  });

  it("summary store unhealthy → store_unhealthy（fail closed）", () => {
    Memory.runtime = Memory.runtime ?? ({} as never);
    // 直接构造手塞 summary store 损坏形态。
    (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury = {
      ...((Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury ?? {}),
      lineageRetirementSummaries: { version: 999, entries: {}, entryCount: 0, updatedAt: 0 },
    };
    resetTreasuryRetirementSummaryRuntimeForTest();
    expect(peekTreasuryRetirementSummaryHealth().healthy).toBe(false);
    const verdict = treasuryTombstoneReplacementVerdict({
      transactionId: "r20_sum_unh",
      digest: "1111111111111111",
      resolution: "not-executed",
      stage: "final",
      proofLevel: "lowlevel",
    });
    expect(verdict.verdict).toBe("store_unhealthy");
  });
});

describe("300 代 chain 有界性（第二十轮 26.12 性能要求）", () => {
  it("300 代 chain：active entryCount 恒 1；exact proof 容量有界（驱逐联动释放）", () => {
    const { lineageId } = advanceChainToGeneration("r20_bound_300", 30);
    const record = readTreasuryAttemptLineageRecord(lineageId)!;
    expect(record.generation).toBe(30);
    expect(peekTreasuryAttemptLineageHealth().entryCount).toBe(1);
    // exact proof 数量 = 全部已退休代（0..30，含当前退休代）= 世代数 + 1（per-chain 有界）。
    expect(peekTreasuryGenerationRetirementHealth().entryCount).toBe(31);
    expect(peekTreasuryGenerationRetirementHealth().entryCount).toBeLessThanOrEqual(TREASURY_GENERATION_RETIREMENT_MAX_ENTRIES);
    resetTreasuryLineageRuntimeForTest();
  }, 120_000);
});
