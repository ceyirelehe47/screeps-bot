/**
 * 【第十九轮】committed lineage resolution 全链闭合测试（任务 25.1/25.2/25.9）。
 *
 * 覆盖：
 * - tr1_ child callback OK + receipt 写入前 commit fault → 显式
 *   resolve-as-committed 闭合（receipt 从 authority 写入完整 lineage proof；
 *   tombstone/verifier/marker/chain_committed 全链绑定）；
 * - tr1_ child receipt 已写入完整 proof 后 heap/finalization 故障 →
 *   resolve-as-committed（refresh 保留既有 proof 只刷 tick——不降级 legacy）；
 * - receipt refresh 的 lineage-aware 身份规则（match 保留 / 缺 proof 阻断 /
 *   initial 禁带 / tr1_ 缺 proof identity 阻断）；
 * - unified unresolved authority 的 lineage proof 矩阵（双存在不一致 /
 *   单侧缺失 / initial 携带 proof）；
 * - 三方 verifier 的逐字段 lineage 冲突（generation N 不能证明 N+1）。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import {
  makeTreasuryTestTransferAdapter,
  replaceTreasuryActionAdapterForTest,
  resetTreasuryTestAdapterSideEffectsForTest,
  type TreasuryActionReconcilerConclusion,
} from "@/runtime/treasury/actionContracts";
import {
  clearTreasuryPersistenceForTest,
  ensureTreasuryReceiptStore,
  lookupTreasurySettledReceipt,
  readTreasurySettlementProof,
  refreshSettledReceiptForResolution,
  commitSettledReceipt,
} from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { readTreasuryQuarantineEntry } from "@/runtime/treasury/quarantine";
import { readTreasuryIntentEntry } from "@/runtime/treasury/intents";
import { readTreasuryResolutionTombstone } from "@/runtime/treasury/resolutionStore";
import {
  lookupTreasuryAttemptLineageByAttemptId,
  createTreasuryAttemptLineageRecord,
  convergeTreasuryLineageRetirementFromFacts,
  stageTreasuryLineageCapabilityIssued,
  stageTreasuryLineageChildIntentPending,
  activateTreasuryLineageChild,
  deriveTreasuryLineageNextChildTransactionId,
  readTreasuryAttemptLineageRecord,
} from "@/runtime/treasury/attemptLineage";
import { resolveTreasuryUnresolvedAuthority } from "@/runtime/treasury/unresolvedAuthority";
import { recomputeTreasuryDurableIdentityDigest } from "@/runtime/treasury/identityProof";
import { verifyTreasuryCommittedResolutionProof } from "@/runtime/treasury/committedProofVerifier";
import { setTreasuryCommitFaultInjectorForTest } from "@/runtime/treasury/writeFault";
import { registerTreasuryPolicyResolver, makeFixedReserveTreasuryPolicy } from "@/runtime/treasury/policyAuthority";
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

/** 【第二十轮】真实 lowlevel chain fixture：root → retirement → gen1 child_active。
 * semantic lineage validation / receipt 门禁按 record 权威重算——伪造 ID 与
 * 无 record 的四字段不再是可接受的 fixture 形态。 */
function seedActiveChildChain(rootId: string, digest = "1111111111111111", durable?: string): {
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
  // 【第二十一轮 6.4】root 的 durable 也按 root facts 重算（durable 参数显式传入时兼容旧 fixture）。
  const rootDurable = durable ?? recomputeTreasuryDurableIdentityDigest({
    transactionId: rootId,
    digest,
    actionKind: "terminal.send",
    source: "test",
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
  });
  if (rootDurable === null) throw new Error("seed root durable recompute failed");
  const created = createTreasuryAttemptLineageRecord({
    rootTransactionId: rootId,
    rootIdentity: { digest, durableIdentityDigest: rootDurable },
    actionKind: "terminal.send",
    authorityClass: "lowlevel",
    lowlevelSource: "runtime-lowlevel@v1",
    rearmable: true,
    retrySemanticDigest: "6666666666666666",
  });
  if (created.status !== "written") throw new Error("seed chain create failed");
  const lineageId = created.record.lineageId;
  const converged = convergeTreasuryLineageRetirementFromFacts(lineageId);
  if (converged.status !== "completed") throw new Error("seed chain converge failed: " + JSON.stringify(converged));
  const childId = deriveTreasuryLineageNextChildTransactionId(lineageId, 1, rootId);
  if (stageTreasuryLineageCapabilityIssued(lineageId, childId).status === "rejected") throw new Error("seed stage issued failed");
  if (stageTreasuryLineageChildIntentPending(lineageId, childId).status === "rejected") throw new Error("seed stage pending failed");
  // 【第二十一轮 6.4】durable 缺省按 intent facts（含 lineage 四字段）真实重算——
  // semantic current 分支完整比较 durable，chain 与 intent 的 durable 必须同源。
  const pendingBinding = readTreasuryAttemptLineageRecord(lineageId)!.pendingBindingDigest!;
  const resolvedDurable = durable ?? recomputeTreasuryDurableIdentityDigest({
    transactionId: childId,
    digest,
    actionKind: "terminal.send",
    source: "test",
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
    lineageId,
    lineageGeneration: 1,
    parentTransactionId: rootId,
    lineageBindingDigest: pendingBinding,
  });
  if (resolvedDurable === null) throw new Error("seed durable recompute failed");
  const activated = activateTreasuryLineageChild(lineageId, { digest, durableIdentityDigest: resolvedDurable, lowlevelSource: "runtime-lowlevel@v1" });
  if (activated.status === "rejected") throw new Error("seed activate failed");
  return {
    childId,
    lineageId,
    identity: {
      digest,
      durableIdentityDigest: resolvedDurable,
      lowlevelSource: "runtime-lowlevel@v1",
      lineageId,
      lineageGeneration: 1,
      parentTransactionId: rootId,
      lineageBindingDigest: readTreasuryAttemptLineageRecord(lineageId)!.bindingDigest!,
    },
  };
}

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

/** 低层 kernel 通道制造 not-executed root（quarantine → resolver 收敛）。 */
function makeLowlevelNotExecutedParent(service: TreasuryTestService, transactionId: string): void {
  const executed = service.executePreparedAction(freshInput(service, transactionId), () => {
    service.endTick();
    return { ok: false as const };
  });
  expect(executed.status).toBe("executed_abort_failed");
  expect(readTreasuryQuarantineEntry(transactionId)).toBeDefined();
}

/** 显式 resolve-as-committed（reconciler 结论 observed_committed）。 */
function resolveAsCommitted(service: TreasuryTestService, transactionId: string) {
  const issued = service.issueTreasuryReconciliationCapability({ transactionId });
  if (issued.status !== "issued") return issued;
  return service.resolveUnresolvedTransaction({ transactionId, capability: issued.capability });
}

function resolveNotExecuted(service: TreasuryTestService, transactionId: string) {
  const issued = service.issueTreasuryReconciliationCapability({ transactionId });
  if (issued.status !== "issued") return issued;
  return service.resolveUnresolvedTransaction({ transactionId, capability: issued.capability });
}

/** 当前代 record 的期望 lineage proof 四字段（断言共用视图）。 */
function expectedLineageProofOf(childId: string): { lineageId: string; generation: number; parent: string; binding: string } | null {
  const record = lookupTreasuryAttemptLineageByAttemptId(childId);
  if (record === undefined || record.bindingDigest === undefined || record.currentParentTransactionId === undefined) return null;
  return { lineageId: record.lineageId, generation: record.generation, parent: record.currentParentTransactionId, binding: record.bindingDigest };
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

describe("tr1_ committed resolution（第十九轮 25.1/25.9：receipt 写入前/后故障均可安全闭合）", () => {
  it("场景 A：receipt 写入前 commit fault → 显式 resolve-as-committed 闭合（receipt 从 authority 写入完整 lineage proof；tombstone/chain_committed 同源）", () => {
    const service = makeService();
    makeLowlevelNotExecutedParent(service, "r19_ca_root");
    const t1 = advanceTick();
    expect(resolveNotExecuted(t1, "r19_ca_root").status).toBe("resolved");
    const issued = t1.issueTreasuryRearmCapability({ parentTransactionId: "r19_ca_root" });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    const childId = issued.childTransactionId;
    // callback OK，但 receipt 发布前 commit fault。
    setTreasuryCommitFaultInjectorForTest(() => {
      throw new Error("r19-injected: receipt_publish");
    });
    const executed = t1.executePreparedAction(
      freshInput(t1, childId),
      () => ({ ok: true as const }),
      { rearmCapability: issued.capability },
    );
    expect(executed.status).toBe("executed_unsettled");
    expect(readTreasuryQuarantineEntry(childId)).toBeDefined();
    // receipt 未写（fault 在 receipt_publish）。
    expect(readTreasurySettlementProof(childId)).toBeUndefined();
    // lineage 保持 child_active（commit 未完成）。
    expect(lookupTreasuryAttemptLineageByAttemptId(childId)?.state).toBe("child_active");
    // ── 显式 resolve-as-committed 闭合。
    setTreasuryCommitFaultInjectorForTest(null);
    const t2 = advanceTick();
    reconcilerConclusion = "observed_committed";
    const resolved = resolveAsCommitted(t2, childId);
    expect(resolved.status).toBe("resolved");
    if (resolved.status !== "resolved") return;
    expect(resolved.resolution).toBe("committed");
    const proof = expectedLineageProofOf(childId)!;
    expect(proof).not.toBeNull();
    // receipt 从 authority 写入完整 lineage proof。
    const receipt = readTreasurySettlementProof(childId);
    expect(receipt?.level).toBe("lowlevel");
    expect(receipt?.lineageId).toBe(proof.lineageId);
    expect(receipt?.lineageGeneration).toBe(proof.generation);
    expect(receipt?.parentTransactionId).toBe(proof.parent);
    expect(receipt?.lineageBindingDigest).toBe(proof.binding);
    // final tombstone 同源携带完整 proof。
    const tombstone = readTreasuryResolutionTombstone(childId);
    expect(tombstone?.stage).toBe("final");
    expect(tombstone?.resolution).toBe("committed");
    expect(tombstone?.lineageId).toBe(proof.lineageId);
    expect(tombstone?.lineageGeneration).toBe(proof.generation);
    expect(tombstone?.parentTransactionId).toBe(proof.parent);
    expect(tombstone?.lineageBindingDigest).toBe(proof.binding);
    // authority 已释放、lineage chain_committed、无 generation 混用。
    expect(readTreasuryQuarantineEntry(childId)).toBeUndefined();
    expect(readTreasuryIntentEntry(childId)).toBeUndefined();
    const record = lookupTreasuryAttemptLineageByAttemptId(childId);
    expect(record?.state).toBe("chain_committed");
    expect(record?.generation).toBe(proof.generation);
    expect(receipt?.lineageGeneration).toBe(record?.generation);
  });

  it("场景 B：receipt 已写入完整 proof 后 heap 故障 → resolve-as-committed（refresh 保留既有 proof 只刷 tick——不降级 legacy）", () => {
    const service = makeService();
    makeLowlevelNotExecutedParent(service, "r19_cb_root");
    const t1 = advanceTick();
    expect(resolveNotExecuted(t1, "r19_cb_root").status).toBe("resolved");
    const issued = t1.issueTreasuryRearmCapability({ parentTransactionId: "r19_cb_root" });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    const childId = issued.childTransactionId;
    // receipt 写入成功之后（heap_publish）才注入 fault。
    setTreasuryCommitFaultInjectorForTest((phase) => {
      if (phase === "receipt_publish") return;
      throw new Error("r19-injected: after receipt");
    });
    const executed = t1.executePreparedAction(
      freshInput(t1, childId),
      () => ({ ok: true as const }),
      { rearmCapability: issued.capability },
    );
    expect(executed.status).toBe("executed_unsettled");
    // receipt 已带完整 lineage proof（receipt_publish 已成功）。
    const proof = expectedLineageProofOf(childId)!;
    const receiptBefore = readTreasurySettlementProof(childId);
    expect(receiptBefore?.lineageId).toBe(proof.lineageId);
    expect(receiptBefore?.lineageGeneration).toBe(proof.generation);
    expect(receiptBefore?.lineageBindingDigest).toBe(proof.binding);
    expect(receiptBefore?.parentTransactionId).toBe(proof.parent);
    // ── resolve-as-committed：refresh 必须原样保留 proof（不降级）。
    setTreasuryCommitFaultInjectorForTest(null);
    const t2 = advanceTick();
    reconcilerConclusion = "observed_committed";
    const resolved = resolveAsCommitted(t2, childId);
    expect(resolved.status).toBe("resolved");
    if (resolved.status !== "resolved") return;
    const receiptAfter = readTreasurySettlementProof(childId);
    expect(receiptAfter?.level).not.toBe("legacy");
    expect(receiptAfter?.lineageId).toBe(proof.lineageId);
    expect(receiptAfter?.lineageGeneration).toBe(proof.generation);
    expect(receiptAfter?.parentTransactionId).toBe(proof.parent);
    expect(receiptAfter?.lineageBindingDigest).toBe(proof.binding);
    const record = lookupTreasuryAttemptLineageByAttemptId(childId);
    expect(record?.state).toBe("chain_committed");
    expect(record?.generation).toBe(proof.generation);
    // final tombstone 同源。
    const tombstone = readTreasuryResolutionTombstone(childId);
    expect(tombstone?.lineageBindingDigest).toBe(proof.binding);
    expect(tombstone?.lineageGeneration).toBe(proof.generation);
  });
});

describe("receipt refresh 的 lineage-aware 身份规则（第十九轮 25.2）", () => {
  it("既有完整 tr1_ receipt 与当前 attempt 完全匹配：只刷新 tick、四字段原样保留", () => {
    ensureTreasuryReceiptStore();
    // 【第二十轮】真实 chain fixture（record 是 semantic 门禁的权威——伪造
    // ID/无 record 的四字段不再是合法 fixture 形态）。
    const chain = seedActiveChildChain("r19_rf_match_root");
    const childId = chain.childId;
    const identity = chain.identity;
    const committed = commitSettledReceipt(childId, Game.time, identity);
    expect(committed.status).toBe("written");
    Game.time += 3;
    const refreshed = refreshSettledReceiptForResolution(childId, Game.time, identity);
    expect(refreshed.status).toBe("refreshed");
    if (refreshed.status === "refreshed") expect(refreshed.previousTick).toBe(Game.time - 3);
    const proof = readTreasurySettlementProof(childId);
    expect(proof?.level).toBe("lowlevel");
    expect(proof?.lineageId).toBe(chain.lineageId);
    expect(proof?.lineageGeneration).toBe(1);
    expect(proof?.parentTransactionId).toBe("r19_rf_match_root");
    expect(proof?.lineageBindingDigest).toBe(identity.lineageBindingDigest);
  });

  it("既有 tr1_ receipt 缺 proof（v7 迁移形态）：refresh 不自动补齐/升级——继续 replay blocker", () => {
    ensureTreasuryReceiptStore();
    const chain = seedActiveChildChain("r19_rf_legacy_root", "4444444444444444", "5555555555555555");
    const childId = chain.childId;
    // 手塞 v7→v8 迁移后的缺 proof modern receipt（lookup 归一 legacy_committed）。
    // 【第二十一轮 13.1】与 lowlevel 链一致的低层 receipt（identity-bound proof
    // 不能出现在 lowlevel chain——class 矛盾会被 semantic gate 先行拦截）。
    Memory.runtime!.treasury!.receipts!.settled[`t:${childId}`] = {
      level: "lowlevel",
      settledAtTick: Game.time,
      digest: "4444444444444444",
      durableIdentityDigest: "5555555555555555",
      lowlevelSource: "runtime-lowlevel@v1",
    } as never;
    Game.time += 1;
    const refreshed = refreshSettledReceiptForResolution(childId, Game.time, { ...chain.identity });
    expect(refreshed.status).toBe("blocked");
    if (refreshed.status === "blocked") expect(refreshed.reason).toBe("legacy_proof");
    // 原 proof 未被覆盖/升级（持久 lowlevel proof 原样保留；readTreasurySettlementProof
    // 对缺 lineage 的 tr1_ receipt 返回归一 legacy 视图——replay blocker 语义）。
    expect(readTreasurySettlementProof(childId)?.level).toBe("legacy");
  });

  it("tr1_ refresh 的 identity 缺 lineage proof：blocked insufficient（不写 legacy、不猜测 generation）", () => {
    ensureTreasuryReceiptStore();
    const childId = "tr1_0123456789abcdef_000003_00112233";
    const refreshed = refreshSettledReceiptForResolution(childId, Game.time, {
      digest: "1111111111111111",
      durableIdentityDigest: "2222222222222222",
    });
    expect(refreshed.status).toBe("blocked");
    if (refreshed.status === "blocked") expect(refreshed.reason).toBe("insufficient_proof");
    expect(lookupTreasurySettledReceipt(childId).status).toBe("absent");
  });

  it("非 tr1_（initial）refresh 携带 lineage proof：blocked identity_conflict", () => {
    ensureTreasuryReceiptStore();
    const refreshed = refreshSettledReceiptForResolution("r19_initial_tx", Game.time, {
      digest: "1111111111111111",
      durableIdentityDigest: "2222222222222222",
      lineageId: "0123456789abcdef",
      lineageGeneration: 1,
      parentTransactionId: "r19_rf_parent3",
      lineageBindingDigest: "3333333333333333",
    });
    expect(refreshed.status).toBe("blocked");
    if (refreshed.status === "blocked") expect(refreshed.reason).toBe("identity_conflict");
  });

  it("既有完整 tr1_ receipt 与刷新 identity 的 binding 冲突：拒绝刷新", () => {
    ensureTreasuryReceiptStore();
    const chain = seedActiveChildChain("r19_rf_conflict_root");
    const childId = chain.childId;
    const committed = commitSettledReceipt(childId, Game.time, chain.identity);
    expect(committed.status).toBe("written");
    Game.time += 1;
    // binding 换成格式合法但与 record 重算不同的 digest。
    const refreshed = refreshSettledReceiptForResolution(childId, Game.time, {
      ...chain.identity,
      lineageBindingDigest: "9999999999999999",
    });
    expect(refreshed.status).toBe("blocked");
    if (refreshed.status === "blocked") expect(refreshed.reason).toBe("identity_conflict");
    // 原 proof 未被覆盖（四字段原样保留）。
    expect(readTreasurySettlementProof(childId)?.lineageBindingDigest).toBe(chain.identity.lineageBindingDigest);
  });
});

describe("unified unresolved authority 的 lineage proof 矩阵（第十九轮 25.1/25.9）", () => {
  /** 手塞低层 intent entry（绕过 write 校验——构造持久层矛盾形态；
   * durableIdentityDigest 用真实重算值保证 store 可信）。 */
  function seedIntent(transactionId: string, extra: Record<string, unknown>): void {
    Memory.runtime = Memory.runtime ?? {};
    const branch = (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury ?? {};
    (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury = branch;
    const intents = (branch.intents ?? { version: 7, entries: {}, entryCount: 0, updatedAt: Game.time }) as Record<string, unknown>;
    const entries = intents.entries as Record<string, unknown>;
    const entry: Record<string, unknown> = {
      transactionId,
      digest: "1111111111111111",
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
      outcome: "started_unknown",
      settlement: "executing",
      createdAtTick: Game.time,
      updatedAtTick: Game.time,
      authorityLevel: "lowlevel",
      lowlevelSource: "runtime-lowlevel@v1",
      ...extra,
    };
    // 【第二十一轮】extra 可显式提供与 lineage record 同源的 durable（缺省才真实重算）。
    entry.durableIdentityDigest = (extra.durableIdentityDigest as string | undefined) ?? recomputeTreasuryDurableIdentityDigest(entry as never) ?? undefined;
    entries[`i:${transactionId}`] = entry;
    intents.entryCount = Object.keys(entries).length;
    branch.intents = intents;
  }

  it("intent-only：tr1_ intent 缺完整 proof → store 层 fail closed（resolver store_unhealthy——不得签发普通 capability）", () => {
    seedIntent("tr1_0123456789abcdef_000005_00112233", {});
    const resolution = resolveTreasuryUnresolvedAuthority("tr1_0123456789abcdef_000005_00112233");
    expect(resolution.status).toBe("store_unhealthy");
    if (resolution.status === "store_unhealthy") expect(resolution.intentStoreError).toContain("lineage");
  });

  it("intent-only：tr1_ intent 部分携带 proof（无 binding）→ store 层 fail closed", () => {
    seedIntent("tr1_0123456789abcdef_000006_00112233", {
      lineageId: "0123456789abcdef",
      lineageGeneration: 1,
      parentTransactionId: "r19_partial_parent",
    });
    const resolution = resolveTreasuryUnresolvedAuthority("tr1_0123456789abcdef_000006_00112233");
    expect(resolution.status).toBe("store_unhealthy");
  });

  it("intent-only：initial attempt 携带完整 proof → store 层 fail closed（initial 禁带）", () => {
    seedIntent("r19_initial_carry", {
      lineageId: "0123456789abcdef",
      lineageGeneration: 1,
      parentTransactionId: "r19_initial_parent",
      lineageBindingDigest: "3333333333333333",
    });
    const resolution = resolveTreasuryUnresolvedAuthority("r19_initial_carry");
    expect(resolution.status).toBe("store_unhealthy");
    if (resolution.status === "store_unhealthy") expect(resolution.intentStoreError).toContain("initial");
  });

  it("intent-only：tr1_ intent 携带完整 proof → ok 且 authority 暴露四字段", () => {
    // 【第二十轮】resolver 对 tr1_ 叠加 semantic gate——fixture 必须携带与
    // record 一致的真实四字段（权威重算 binding）。
    const chain = seedActiveChildChain("r19_ok_parent");
    seedIntent(chain.childId, {
      lineageId: chain.lineageId,
      lineageGeneration: 1,
      parentTransactionId: "r19_ok_parent",
      lineageBindingDigest: chain.identity.lineageBindingDigest,
      digest: "1111111111111111",
      // 【第二十一轮 6.4】durable 由 helper 真实重算（与 chain 同源——semantic current 完整比较）。
    });
    const resolution = resolveTreasuryUnresolvedAuthority(chain.childId);
    expect(resolution.status).toBe("ok");
    if (resolution.status === "ok") {
      expect(resolution.authority.lineageId).toBe(chain.lineageId);
      expect(resolution.authority.lineageGeneration).toBe(1);
      expect(resolution.authority.parentTransactionId).toBe("r19_ok_parent");
      expect(resolution.authority.lineageBindingDigest).toBe(chain.identity.lineageBindingDigest);
    }
  });

  it("双存在：quarantine 与 intent 的 proof 不一致（binding 不同）→ inconsistent（不任选其一）", () => {
    const childId = "tr1_0123456789abcdef_000008_00112233";
    seedIntent(childId, {
      lineageId: "0123456789abcdef",
      lineageGeneration: 1,
      parentTransactionId: "r19_dual_parent",
      lineageBindingDigest: "3333333333333333",
    });
    // 手塞同 id quarantine（shape 由 load 校验承载；构造一致形态、仅 binding 不同）。
    const quarantineEntry: Record<string, unknown> = {
      transactionId: childId,
      digest: "1111111111111111",
      kind: "terminal.send",
      actionKind: "terminal.send",
      source: "test",
      deltas: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
      phase: "action_threw_execution_unknown",
      outcome: "started_unknown",
      settlement: "quarantined",
      tick: Game.time,
      recordedAt: Game.time,
      authorityLevel: "lowlevel",
      lowlevelSource: "runtime-lowlevel@v1",
      lineageId: "0123456789abcdef",
      lineageGeneration: 1,
      parentTransactionId: "r19_dual_parent",
      lineageBindingDigest: "4444444444444444",
    };
    quarantineEntry.durableIdentityDigest = recomputeTreasuryDurableIdentityDigest(quarantineEntry as never) ?? undefined;
    Memory.runtime!.treasury!.quarantine = {
      version: 6,
      entries: { [`q:${childId}`]: quarantineEntry },
      entryCount: 1,
      updatedAt: Game.time,
    } as never;
    const resolution = resolveTreasuryUnresolvedAuthority(childId);
    expect(resolution.status).toBe("inconsistent");
    if (resolution.status === "inconsistent") expect(resolution.detail).toContain("lineage proof");
  });
});

describe("committed 三方 verifier 的 lineage 维度（第十九轮 25.9：逐字段冲突）", () => {
  const baseIdentity = {
    digest: "1111111111111111",
    durableIdentityDigest: "2222222222222222",
    lowlevelSource: "runtime-lowlevel@v1",
    authorityLevel: "lowlevel",
  };
  const baseProof = {
    lineageId: "0123456789abcdef",
    lineageGeneration: 1,
    parentTransactionId: "r19_v_parent",
    lineageBindingDigest: "3333333333333333",
  };
  const receipt = { level: "lowlevel", settledAtTick: 100, ...baseIdentity, ...baseProof };
  const tombstone = {
    transactionId: "tr1_0123456789abcdef_000009_00112233",
    proofLevel: "lowlevel" as const,
    settledAtTick: 100,
    ...baseIdentity,
    ...baseProof,
  };

  const verifierAuthority = (extra: Record<string, unknown>) => ({
    status: "ok" as const,
    authority: {
      authorityKind: "quarantine" as const,
      transactionId: tombstone.transactionId,
      kind: "terminal.send",
      actionKind: "terminal.send",
      recordedAt: 90,
      outcome: "returned_ok",
      settlement: "executing",
      phase: "ok_pending_commit",
      actionTick: 90,
      postings: [],
      ...baseIdentity,
      ...extra,
    },
  });

  it("lineageId / generation / parent / binding 任一不同 → conflict（generation N 不能证明 N+1）", () => {
    for (const mutation of [
      { field: "lineageId", value: "ffffffffffffffff" },
      { field: "lineageGeneration", value: 2 },
      { field: "parentTransactionId", value: "r19_other_parent" },
      { field: "lineageBindingDigest", value: "9999999999999999" },
    ] as const) {
      const mutatedTombstone = { ...tombstone, [mutation.field]: mutation.value };
      const verdict = verifyTreasuryCommittedResolutionProof({
        tombstone: mutatedTombstone,
        authorityResolution: verifierAuthority({ ...baseProof }),
        receiptProof: receipt,
        // 【第二十轮 13.4】tr1_ 附 semantic verdict（mutated 字段间互不一致由
        // 三方 relation 抓获——semantic 维度以 match 为基线）。
        semanticLineageVerdict: { verdict: "match" },
      });
      expect(verdict.status).toBe("conflict");
      if (verdict.status === "conflict") expect(verdict.detail).toContain("conflict");
    }
  });

  it("tr1_ authority（携带 proof）而 receipt 缺 proof → insufficient（旧 proof 不得冒充当前 generation）", () => {
    const verdict = verifyTreasuryCommittedResolutionProof({
      tombstone,
      authorityResolution: verifierAuthority({ ...baseProof }),
      receiptProof: { level: "lowlevel", settledAtTick: 100, ...baseIdentity },
      semanticLineageVerdict: { verdict: "match" },
    });
    expect(verdict.status).toBe("insufficient");
  });

  it("initial authority（无 proof）而 tombstone/receipt 携带 proof → conflict", () => {
    const verdict = verifyTreasuryCommittedResolutionProof({
      tombstone,
      authorityResolution: verifierAuthority({}),
      receiptProof: receipt,
      semanticLineageVerdict: { verdict: "match" },
    });
    expect(verdict.status).toBe("conflict");
  });

  it("三方 lineage 全一致（lowlevel 链）→ verified", () => {
    const verdict = verifyTreasuryCommittedResolutionProof({
      tombstone,
      authorityResolution: verifierAuthority({ ...baseProof }),
      receiptProof: receipt,
      semanticLineageVerdict: { verdict: "match" },
    });
    expect(verdict.status).toBe("verified");
    if (verdict.status === "verified") expect(verdict.authorityPresent).toBe(true);
  });
});
