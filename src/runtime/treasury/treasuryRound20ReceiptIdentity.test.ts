/**
 * 【第二十轮】receipt exact identity 幂等与写入门禁测试（任务 26.5/26.6/26.12）。
 *
 * 覆盖：
 * - matching tr1_ receipt 在 global reset 后 commit 重入 → exact match
 *   already_settled_match（不进入永久 fault）；
 * - 逐字段变化拒绝（lineageId/generation/parent/binding/contract/cohort/
 *   durable/proof class/lowlevel）；
 * - matching receipt 的 heap publish fault / finalization fault 恢复 →
 *   chain committed；
 * - tr1_ 新 commit 门禁（缺 proof 零写、ID 语义不匹配零写、binding 错误
 *   零写、active lineage 不允许零写、initial 携带 proof 零写、正确 commit
 *   写入完整 proof、validator 未装配 fail closed）；
 * - refresh（matching 保留刷 tick、legacy blocked 不自动补全）。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import {
  clearTreasuryPersistenceForTest,
  ensureTreasuryReceiptStore,
  readTreasurySettlementProof,
  refreshSettledReceiptForResolution,
  commitSettledReceipt,
} from "@/runtime/treasury/receipts";
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
} from "@/runtime/treasury/attemptLineage";
import { closeTreasuryLineageAsChainCommitted } from "@/runtime/treasury/attemptLineage";
import { resetTreasurySemanticLineageSourcesForTest } from "@/runtime/treasury/semanticLineageValidation";
import { registerTreasuryAttemptLineageSemanticSourceForAssembly } from "@/runtime/treasury/attemptLineage";
import { registerTreasuryRetirementSummarySemanticSourceForAssembly } from "@/runtime/treasury/lineageRetirementSummary";
import { registerTreasuryGenerationRetirementSemanticSourceForAssembly } from "@/runtime/treasury/generationRetirementAuthority";
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

let reconcilerConclusion: TreasuryActionReconcilerConclusion = "observed_not_executed";

/** 真实低层 chain fixture → gen1 child_active（与 facade commit 语义一致的 identity 维度）。 */
function seedActiveChildChain(rootId: string, digest = "1111111111111111", durable = "2222222222222222"): {
  readonly childId: string;
  readonly lineageId: string;
  readonly identity: {
    readonly digest: string;
    readonly durableIdentityDigest: string;
    readonly lowlevelSource: string;
    readonly lineageId: string;
    readonly lineageGeneration: number;
    readonly parentTransactionId: string;
    readonly lineageBindingDigest: string;
  };
} {
  const created = createTreasuryAttemptLineageRecord({
    rootTransactionId: rootId,
    rootIdentity: { digest, durableIdentityDigest: durable },
    actionKind: "terminal.send",
    authorityClass: "lowlevel",
    lowlevelSource: "runtime-lowlevel@v1",
    rearmable: true,
    retrySemanticDigest: "6666666666666666",
  });
  if (created.status !== "written") throw new Error("seed chain create failed");
  const lineageId = created.record.lineageId;
  const converged = convergeTreasuryLineageRetirementFromFacts(lineageId);
  if (converged.status !== "completed") throw new Error("seed converge failed");
  const childId = deriveTreasuryLineageNextChildTransactionId(lineageId, 1, rootId);
  if (stageTreasuryLineageCapabilityIssued(lineageId, childId).status === "rejected") throw new Error("stage issued failed");
  if (stageTreasuryLineageChildIntentPending(lineageId, childId).status === "rejected") throw new Error("stage pending failed");
  const activated = activateTreasuryLineageChild(lineageId, { digest, durableIdentityDigest: durable, lowlevelSource: "runtime-lowlevel@v1" });
  if (activated.status === "rejected") throw new Error("activate failed");
  return {
    childId,
    lineageId,
    identity: {
      digest,
      durableIdentityDigest: durable,
      lowlevelSource: "runtime-lowlevel@v1",
      lineageId,
      lineageGeneration: 1,
      parentTransactionId: rootId,
      lineageBindingDigest: readTreasuryAttemptLineageRecord(lineageId)!.bindingDigest!,
    },
  };
}

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

describe("existing tr1_ receipt 的 exact 幂等（第二十轮 26.5）", () => {
  it("matching receipt 已写，global reset（heap 清）后 commit 重入 → already_settled_match（不进入永久 fault）", () => {
    ensureTreasuryReceiptStore();
    const chain = seedActiveChildChain("r20_rc_idem");
    const first = commitSettledReceipt(chain.childId, Game.time, chain.identity);
    expect(first.status).toBe("written");
    Game.time += 2;
    // global reset 后重入（同 identity——exact 含 lineage 四字段与 proof class）。
    const reentry = commitSettledReceipt(chain.childId, Game.time, chain.identity);
    expect(reentry.status).toBe("already_settled_match");
  });

  it("lineageId / generation / parent / binding 任一不同 → identity_conflict", () => {
    ensureTreasuryReceiptStore();
    const chain = seedActiveChildChain("r20_rc_lgp");
    expect(commitSettledReceipt(chain.childId, Game.time, chain.identity).status).toBe("written");
    for (const mutation of [
      { field: "lineageId", value: "ffffffffffffffff" },
      { field: "lineageGeneration", value: 2 },
      { field: "parentTransactionId", value: "r20_other_parent" },
      { field: "lineageBindingDigest", value: "9999999999999999" },
    ] as const) {
      const reentry = commitSettledReceipt(chain.childId, Game.time, { ...chain.identity, [mutation.field]: mutation.value });
      expect(reentry.status).toBe("identity_conflict");
    }
  });

  it("durableIdentityDigest / lowlevelSource / proof class 不同 → identity_conflict", () => {
    ensureTreasuryReceiptStore();
    const chain = seedActiveChildChain("r20_rc_dims");
    expect(commitSettledReceipt(chain.childId, Game.time, chain.identity).status).toBe("written");
    // durable 不同 → conflict。
    expect(commitSettledReceipt(chain.childId, Game.time, { ...chain.identity, durableIdentityDigest: "8888888888888888" }).status).toBe("identity_conflict");
    // lowlevel provenance 不同 → conflict（runtime 与 migrated 不能互相证明）。
    expect(commitSettledReceipt(chain.childId, Game.time, { ...chain.identity, lowlevelSource: "migrated-lowlevel@v1" }).status).toBe("identity_conflict");
    // proof class 不同（identity-bound 视图 vs lowlevel receipt——去掉
    // lowlevelSource 携带完整 modern 身份）→ conflict。
    const { lowlevelSource: _drop, ...identityBoundView } = chain.identity;
    void _drop;
    expect(commitSettledReceipt(chain.childId, Game.time, { ...identityBoundView, contractDigest: "4444444444444444", authorizationCohortDigest: "5555555555555555" }).status).toBe("identity_conflict");
  });

  it("matching receipt 进入 heap publish fault 恢复 → 最终 chain committed", () => {
    const service = makeService();
    const executed = service.executePreparedAction(freshInput(service, "r20_rc_hp"), () => {
      service.endTick();
      return { ok: false as const };
    });
    expect(executed.status).toBe("executed_abort_failed");
    const t1 = advanceTick();
    const t1resolved = t1.issueTreasuryReconciliationCapability({ transactionId: "r20_rc_hp" });
    expect(t1resolved.status).toBe("issued");
    if (t1resolved.status !== "issued") return;
    expect(t1.resolveUnresolvedTransaction({ transactionId: "r20_rc_hp", capability: t1resolved.capability }).status).toBe("resolved");
    const t2 = advanceTick();
    const issued = t2.issueTreasuryRearmCapability({ parentTransactionId: "r20_rc_hp" });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    // receipt 写入成功、heap publish 注入故障 → executed_unsettled（receipt 已持久化）。
    setTreasuryCommitFaultInjectorForTest((phase: string) => {
      if (phase === "heap_publish") throw new Error("r20-injected: heap_publish");
    });
    const childExecuted = t2.executePreparedAction(freshInput(t2, issued.childTransactionId), () => ({ ok: true as const }), { rearmCapability: issued.capability });
    expect(childExecuted.status).toBe("executed_unsettled");
    expect(readTreasurySettlementProof(issued.childTransactionId)).toBeDefined();
    setTreasuryCommitFaultInjectorForTest(null);
    // beginTick 恢复：commit-pending 补完成 → chain_committed。
    advanceTick();
    const record = lookupTreasuryAttemptLineageByAttemptId(issued.childTransactionId);
    expect(record?.state).toBe("chain_committed");
  });

  it("matching receipt 的 finalization（resolve-as-committed 写前/写后故障）→ 幂等补完成 chain committed", () => {
    const service = makeService();
    const executed = service.executePreparedAction(freshInput(service, "r20_rc_fin"), () => {
      service.endTick();
      return { ok: false as const };
    });
    expect(executed.status).toBe("executed_abort_failed");
    const t1 = advanceTick();
    const cap1 = t1.issueTreasuryReconciliationCapability({ transactionId: "r20_rc_fin" });
    expect(cap1.status).toBe("issued");
    if (cap1.status !== "issued") return;
    expect(t1.resolveUnresolvedTransaction({ transactionId: "r20_rc_fin", capability: cap1.capability }).status).toBe("resolved");
    const t2 = advanceTick();
    const issued = t2.issueTreasuryRearmCapability({ parentTransactionId: "r20_rc_fin" });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    // receipt 写入前 commit fault → executed_unsettled + quarantine authority。
    setTreasuryCommitFaultInjectorForTest(() => {
      throw new Error("r20-injected: receipt_publish");
    });
    const childExecuted = t2.executePreparedAction(freshInput(t2, issued.childTransactionId), () => ({ ok: true as const }), { rearmCapability: issued.capability });
    expect(childExecuted.status).toBe("executed_unsettled");
    setTreasuryCommitFaultInjectorForTest(null);
    // 显式 resolve-as-committed（exact semantic validation 通过）→ receipt 从
    // authority 写入完整 proof → chain committed。
    reconcilerConclusion = "observed_committed";
    const t3 = advanceTick();
    const cap2 = t3.issueTreasuryReconciliationCapability({ transactionId: issued.childTransactionId });
    expect(cap2.status).toBe("issued");
    if (cap2.status !== "issued") return;
    const resolved = t3.resolveUnresolvedTransaction({ transactionId: issued.childTransactionId, capability: cap2.capability });
    expect(resolved.status).toBe("resolved");
    if (resolved.status !== "resolved") return;
    expect(resolved.resolution).toBe("committed");
    const record = lookupTreasuryAttemptLineageByAttemptId(issued.childTransactionId);
    expect(record?.state).toBe("chain_committed");
    // receipt 携带完整 lineage proof。
    const proof = readTreasurySettlementProof(issued.childTransactionId);
    expect(proof?.lineageId).toBe(record?.lineageId);
    expect(proof?.lineageGeneration).toBe(1);
    expect(proof?.parentTransactionId).toBe("r20_rc_fin");
    expect(proof?.lineageBindingDigest).toBe(record?.bindingDigest);
  });
});

describe("tr1_ 新 commit 写入门禁（第二十轮 26.6）", () => {
  it("缺完整 lineage proof → 零写 fatal", () => {
    ensureTreasuryReceiptStore();
    const chain = seedActiveChildChain("r20_gate_nop");
    const { lineageId: _drop, ...identityNoLineage } = chain.identity;
    void _drop;
    const result = commitSettledReceipt(chain.childId, Game.time, {
      digest: identityNoLineage.digest,
      durableIdentityDigest: identityNoLineage.durableIdentityDigest,
      lowlevelSource: identityNoLineage.lowlevelSource,
    });
    expect(result.status).toBe("fatal");
    expect(readTreasurySettlementProof(chain.childId)).toBeUndefined();
  });

  it("四字段完整但 ID 语义不匹配（parent 与派生不符）→ 零写 fatal", () => {
    ensureTreasuryReceiptStore();
    const chain = seedActiveChildChain("r20_gate_sem");
    const result = commitSettledReceipt(chain.childId, Game.time, { ...chain.identity, parentTransactionId: "r20_wrong_parent" });
    expect(result.status).toBe("fatal");
    expect(readTreasurySettlementProof(chain.childId)).toBeUndefined();
  });

  it("binding 错误（重算不一致）→ 零写 fatal", () => {
    ensureTreasuryReceiptStore();
    const chain = seedActiveChildChain("r20_gate_bind");
    const result = commitSettledReceipt(chain.childId, Game.time, { ...chain.identity, lineageBindingDigest: "9999999999999999" });
    expect(result.status).toBe("fatal");
    expect(readTreasurySettlementProof(chain.childId)).toBeUndefined();
  });

  it("active lineage 不允许（在途 pending handoff generation）→ 零写 fatal", () => {
    ensureTreasuryReceiptStore();
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: "r20_gate_pend",
      rootIdentity: { digest: "1111111111111111", durableIdentityDigest: "2222222222222222" },
      actionKind: "terminal.send",
      authorityClass: "lowlevel",
      lowlevelSource: "runtime-lowlevel@v1",
      rearmable: true,
      retrySemanticDigest: "6666666666666666",
    });
    expect(created.status).toBe("written");
    if (created.status !== "written") return;
    expect(convergeTreasuryLineageRetirementFromFacts(created.record.lineageId).status).toBe("completed");
    const childId = deriveTreasuryLineageNextChildTransactionId(created.record.lineageId, 1, "r20_gate_pend");
    expect(stageTreasuryLineageCapabilityIssued(created.record.lineageId, childId).status).not.toBe("rejected");
    expect(stageTreasuryLineageChildIntentPending(created.record.lineageId, childId).status).not.toBe("rejected");
    const record = readTreasuryAttemptLineageRecord(created.record.lineageId)!;
    const result = commitSettledReceipt(childId, Game.time, {
      digest: "1111111111111111",
      durableIdentityDigest: "2222222222222222",
      lowlevelSource: "runtime-lowlevel@v1",
      lineageId: record.lineageId,
      lineageGeneration: 1,
      parentTransactionId: "r20_gate_pend",
      lineageBindingDigest: record.pendingBindingDigest!,
    });
    expect(result.status).toBe("fatal");
    expect(readTreasurySettlementProof(childId)).toBeUndefined();
  });

  it("initial attempt 携带 lineage proof → 零写 fatal", () => {
    ensureTreasuryReceiptStore();
    const result = commitSettledReceipt("r20_gate_initial", Game.time, {
      digest: "1111111111111111",
      durableIdentityDigest: "2222222222222222",
      lineageId: "0123456789abcdef",
      lineageGeneration: 1,
      parentTransactionId: "r20_some_parent",
      lineageBindingDigest: "3333333333333333",
    });
    expect(result.status).toBe("fatal");
    expect(readTreasurySettlementProof("r20_gate_initial")).toBeUndefined();
  });

  it("正确 tr1_ commit（current generation、semantic match）→ written 完整 proof", () => {
    ensureTreasuryReceiptStore();
    const chain = seedActiveChildChain("r20_gate_ok");
    const result = commitSettledReceipt(chain.childId, Game.time, chain.identity);
    expect(result.status).toBe("written");
    const proof = readTreasurySettlementProof(chain.childId);
    expect(proof?.level).toBe("lowlevel");
    expect(proof?.lineageId).toBe(chain.lineageId);
    expect(proof?.lineageGeneration).toBe(1);
    expect(proof?.parentTransactionId).toBe("r20_gate_ok");
    expect(proof?.lineageBindingDigest).toBe(chain.identity.lineageBindingDigest);
    expect(proof?.lowlevelSource).toBe("runtime-lowlevel@v1");
  });

  it("validator 未装配（readers 注销）→ tr1_ production 写入 fail closed", () => {
    ensureTreasuryReceiptStore();
    const chain = seedActiveChildChain("r20_gate_src");
    resetTreasurySemanticLineageSourcesForTest();
    try {
      const result = commitSettledReceipt(chain.childId, Game.time, chain.identity);
      expect(result.status).toBe("fatal");
      expect(readTreasurySettlementProof(chain.childId)).toBeUndefined();
    } finally {
      registerTreasuryAttemptLineageSemanticSourceForAssembly();
      registerTreasuryRetirementSummarySemanticSourceForAssembly();
      registerTreasuryGenerationRetirementSemanticSourceForAssembly();
    }
  });
});

describe("receipt refresh 门禁（第二十轮 26.6）", () => {
  it("matching proof → 保留 identity 仅刷新 tick", () => {
    ensureTreasuryReceiptStore();
    const chain = seedActiveChildChain("r20_rf_match");
    expect(commitSettledReceipt(chain.childId, Game.time, chain.identity).status).toBe("written");
    Game.time += 3;
    const refreshed = refreshSettledReceiptForResolution(chain.childId, Game.time, chain.identity);
    expect(refreshed.status).toBe("refreshed");
    if (refreshed.status === "refreshed") expect(refreshed.previousTick).toBe(Game.time - 3);
    const proof = readTreasurySettlementProof(chain.childId);
    expect(proof?.lineageId).toBe(chain.lineageId);
    expect(proof?.lineageBindingDigest).toBe(chain.identity.lineageBindingDigest);
  });

  it("既有 tr1_ receipt 缺 proof（迁移形态）→ blocked（replay blocker，不自动补全）", () => {
    ensureTreasuryReceiptStore();
    const chain = seedActiveChildChain("r20_rf_legacy", "4444444444444444");
    // 【第二十一轮 13.1】与 lowlevel 链一致的低层 receipt（modern contract 字段
    // 不能出现在 lowlevel chain——semantic gate 先行拦截 class 矛盾）。
    Memory.runtime!.treasury!.receipts!.settled[`t:${chain.childId}`] = {
      level: "lowlevel",
      settledAtTick: Game.time,
      digest: "4444444444444444",
      durableIdentityDigest: chain.identity.durableIdentityDigest,
      lowlevelSource: "runtime-lowlevel@v1",
    } as never;
    Game.time += 1;
    const refreshed = refreshSettledReceiptForResolution(chain.childId, Game.time, { ...chain.identity });
    expect(refreshed.status).toBe("blocked");
    if (refreshed.status === "blocked") expect(refreshed.reason).toBe("legacy_proof");
    expect(readTreasurySettlementProof(chain.childId)?.level).toBe("legacy");
  });

  it("refresh semantic conflict（binding 与权威重算不同）→ blocked identity_conflict 不覆盖", () => {
    ensureTreasuryReceiptStore();
    const chain = seedActiveChildChain("r20_rf_conf");
    expect(commitSettledReceipt(chain.childId, Game.time, chain.identity).status).toBe("written");
    Game.time += 1;
    const refreshed = refreshSettledReceiptForResolution(chain.childId, Game.time, { ...chain.identity, lineageBindingDigest: "9999999999999999" });
    expect(refreshed.status).toBe("blocked");
    if (refreshed.status === "blocked") expect(refreshed.reason).toBe("identity_conflict");
    expect(readTreasurySettlementProof(chain.childId)?.lineageBindingDigest).toBe(chain.identity.lineageBindingDigest);
  });
});

// 防回归：chain_committed 写入结果不被忽略的计数暴露。
describe("chain committed 推进结果处理（第二十轮 26.10）", () => {
  it("close 失败（非 child_active 状态）→ rejected 且不伪装完成", () => {
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: "r20_cc_rej",
      rootIdentity: { digest: "1111111111111111", durableIdentityDigest: "2222222222222222" },
      actionKind: "terminal.send",
      authorityClass: "lowlevel",
      lowlevelSource: "runtime-lowlevel@v1",
      rearmable: true,
      retrySemanticDigest: "6666666666666666",
    });
    expect(created.status).toBe("written");
    if (created.status !== "written") return;
    expect(() => closeTreasuryLineageAsChainCommitted(created.record.lineageId)).toThrow(/child_active/);
  });
});
