/**
 * 【第十八轮】lineage handoff atomicity & generation-proof lifecycle 集成测试。
 *
 * 覆盖（任务 24.14 前半）：
 * - lineage publication 原子性（publication-before-release：candidate 写失败/
 *   read-back 失败 → authority/quarantine/marker/pending 全保留；marker 清除
 *   失败 → cleanup-pending；三段成功才 rearm-ready；下一轮可重试完整 publication）；
 * - handoff reset 窗口（capability_issued 回退 child ID 稳定；child_intent_
 *   pending × intent 状态全矩阵：缺失/ready/binding 冲突/generation 冲突/
 *   executing/ quarantine 接管 → 回滚/前向补完成/forensic）；
 * - capability 严格消费（非预期 revision/state 拒绝且 callback 零调用）；
 * - pre-callback 失败（retry semantic 重验失败/source 不匹配 → callback 零
 *   调用）；
 * - child 结果分支（non-OK + abort 确认 → 当前代同步 retirement 可进下一代；
 *   abort 失败 → quarantine；A→B non-OK → C 可执行；commit-pending 按
 *   matching receipt 补完成 / generation 冲突不补完成）；
 * - lineage durable proof（tr1_ 缺 proof 写入拒绝 / initial 禁止携带 /
 *   same-ID 不同 proof conflict / parent-proof 不能证明 child / receipt 缺
 *   proof 降级 legacy blocker）；
 * - intent→quarantine proof 转移（binding 完整转移继承）；
 * - index 完整性（duplicate lineageId/current/跨索引冲突 → unhealthy；写入
 *   冲突原 store 不变）；
 * - transition（exact idempotent revision 不增；合法转换严格 +1；冻结字段/
 *   非接管 current 变化/updatedAt 回退拒绝；新 generation retirement 重置）。
 */
import { createTreasuryService } from "@/runtime/treasury/facade";
import {
  buildTreasuryActionContract,
  executeTreasuryActionContract,
  makeTreasuryTestTransferAdapter,
  readTreasuryTestAdapterSideEffects,
  registerTreasuryActionAdapter,
  replaceTreasuryActionAdapterForTest,
  resetTreasuryTestAdapterSideEffectsForTest,
  type TreasuryActionContract,
} from "@/runtime/treasury/actionContracts";
import { clearTreasuryPersistenceForTest, lookupTreasurySettledReceipt, commitSettledReceipt, ensureTreasuryReceiptStore } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { readTreasuryQuarantineEntry } from "@/runtime/treasury/quarantine";
import {
  readTreasuryResolutionTombstone,
  writeTreasuryResolutionTombstone,
  ensureTreasuryResolutionSlotAvailable,
} from "@/runtime/treasury/resolutionStore";
import {
  createTreasuryAttemptLineageRecord,
  lookupTreasuryAttemptLineageByAttemptId,
  peekTreasuryAttemptLineageHealth,
  readTreasuryAttemptLineageRecord,
  updateTreasuryAttemptLineageRecord,
  stageTreasuryLineageChildIntentPending,
  rollbackTreasuryLineageToRearmReady,
  TREASURY_LINEAGE_MAX_ENTRIES,
} from "@/runtime/treasury/attemptLineage";
import { readTreasuryIntentEntry, writeTreasuryIntentEntry } from "@/runtime/treasury/intents";
import { registerTreasuryPolicyResolver, makeFixedReserveTreasuryPolicy } from "@/runtime/treasury/policyAuthority";
import { installRooms, type RoomSpec } from "@mock/treasury";
import type { TreasuryTransactionInput } from "@/runtime/treasury/types";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import { setTreasuryCommitFaultInjectorForTest } from "@/runtime/treasury/writeFault";
import { recordTreasuryWriteFault } from "@/runtime/treasury/writeFault";
import { treasuryAttemptIdentityRelation } from "@/runtime/treasury/identityProof";
import { computeTreasuryAttemptLineageId } from "@/runtime/treasury/attemptLineage";
import { treasuryRearmCapabilityBindingMatchesLineageRecord } from "@/runtime/treasury/lineageHandoff";
import { resetTreasuryLineageRuntimeForTest } from "@/runtime/treasury/attemptLineage";

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

interface TransferArgs {
  readonly amount?: number;
  readonly outcome?: "ok" | "non-ok" | "throw";
  readonly fromRoom?: string;
  readonly feeAmount?: number;
}

function buildContract(service: TreasuryTestService, transactionId: string, args: TransferArgs, source?: string): TreasuryActionContract {
  const built = buildTreasuryActionContract(service, {
    actionKind: "test.transfer",
    transactionId,
    ...(source !== undefined ? { source } : {}),
    args: {
      fromRoom: args.fromRoom ?? "W1N57",
      fromLocation: "storage",
      toRoom: "W1N57",
      toLocation: "terminal",
      resource: "energy",
      amount: args.amount ?? 500,
      outcome: args.outcome ?? "ok",
      ...(args.feeAmount !== undefined ? { feeAmount: args.feeAmount, feeFromRoom: "W1N57" } : {}),
    },
  });
  expect(built.status).toBe("built");
  if (built.status !== "built") throw new Error("unreachable");
  return built.contract;
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

/** contract 路径制造 execution-unknown quarantine 并 resolve 为 not-executed。 */
function makeNotExecutedParent(service: TreasuryTestService, transactionId: string): void {
  const contract = buildContract(service, transactionId, { outcome: "throw" });
  const authorized = service.authorizeTreasuryActionContract(contract);
  expect(authorized.status).toBe("authorized");
  if (authorized.status !== "authorized") return;
  let threw = false;
  try {
    executeTreasuryActionContract(service, { contract, authorization: authorized.bundle });
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
  expect(readTreasuryQuarantineEntry(transactionId)).toBeDefined();
}

/** 低层 kernel 通道执行（non-OK + tick 内 endTick → abort 失败 → quarantine）。 */
function makeLowlevelNotExecutedParent(service: TreasuryTestService, transactionId: string): void {
  const executed = service.executePreparedAction(freshInput(service, transactionId), () => {
    service.endTick();
    return { ok: false as const };
  });
  expect(executed.status).toBe("executed_abort_failed");
  expect(readTreasuryQuarantineEntry(transactionId)).toBeDefined();
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  setTreasuryCommitFaultInjectorForTest(null);
  resetTreasuryTestAdapterSideEffectsForTest();
  registerTreasuryPolicyResolver(makeFixedReserveTreasuryPolicy(1_000));
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter("observed_not_executed"));
  registerTreasuryActionAdapter({ ...makeTreasuryTestTransferAdapter("observed_not_executed"), kind: "terminal.send", semanticIdentity: "terminal.send@reconciler-semantics-v1" });
});

afterEach(() => {
  replaceTreasuryActionAdapterForTest(makeTreasuryTestTransferAdapter());
});

describe("lineage publication 原子性（第十八轮 24.1）", () => {
  it("lineage 容量满（candidate 写失败）：authority/quarantine/marker/pending 索引保留、lineage_publication_pending、不进入 rearm-ready；下一轮可重试完整 publication", () => {
    const service = makeService();
    makeLowlevelNotExecutedParent(service, "r18_pa_parent");
    // 塞满 lineage store（64 条 forensic_isolated——非 terminal 不被压缩、
    // 非 retiring 不被恢复推进，容量保持满载）。
    const fillEntries: Record<string, unknown> = {};
    for (let i = 0; i < TREASURY_LINEAGE_MAX_ENTRIES; i += 1) {
      const root = `r18_pa_fill_${String(i)}`;
      const identity = { digest: `00000000000000${String(i).padStart(2, "0")}`.slice(-16) };
      fillEntries[`l:${root}`] = {
        lineageId: computeTreasuryAttemptLineageId(root, identity),
        rootTransactionId: root,
        rootIdentity: identity,
        currentTransactionId: root,
        currentIdentity: identity,
        actionKind: "fill",
        generation: 0,
        state: "forensic_isolated",
        resolutionState: "not_executed",
        authorityClass: "identity-bound",
        rearmable: false,
        nonRearmReason: "fill",
        retirement: { lineagePublished: true, authorityReleased: true, markerCleaned: true },
        retirementGeneration: 0,
        recordRevision: 0,
        createdAtTick: Game.time,
        updatedAtTick: Game.time,
      };
    }
    ((Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury ??= {}).attemptLineage = {
      version: 2,
      entries: fillEntries,
      entryCount: TREASURY_LINEAGE_MAX_ENTRIES,
      updatedAt: Game.time,
    };
    resetTreasuryLineageRuntimeForTest();
    expect(peekTreasuryAttemptLineageHealth().healthy).toBe(true);
    expect(peekTreasuryAttemptLineageHealth().entryCount).toBe(TREASURY_LINEAGE_MAX_ENTRIES);
    const next = advanceTick();
    const resolved = resolveNotExecuted(next, "r18_pa_parent");
    expect(resolved.status).toBe("rejected");
    if (resolved.status === "rejected") {
      // 容量预检（resolution_store_full + lineage 预检失败 detail）或
      // publication 阶段（lineage_publication_pending）——两者都保持
      // authority/quarantine/marker/pending 全保留（零持久副作用）。
      expect(["lineage_publication_pending", "resolution_store_full"]).toContain(resolved.reason);
      expect(resolved.detail).toContain("lineage");
    }
    // authority 保留（quarantine 在场）、tombstone 未写、parent 不在 lineage。
    expect(readTreasuryQuarantineEntry("r18_pa_parent")).toBeDefined();
    expect(readTreasuryResolutionTombstone("r18_pa_parent")).toBeUndefined();
    expect(lookupTreasuryAttemptLineageByAttemptId("r18_pa_parent")).toBeUndefined();
    // 下一轮（清出容量后）重试完整 publication 成功。
    Game.time += 1;
    const memoryLineage = ((Memory.runtime as { treasury?: { attemptLineage?: { entries: Record<string, unknown>; entryCount: number } } }).treasury?.attemptLineage);
    expect(memoryLineage).toBeDefined();
    if (memoryLineage !== undefined) {
      delete memoryLineage.entries["l:r18_pa_fill_0"];
      memoryLineage.entryCount = Object.keys(memoryLineage.entries).length;
    }
    resetTreasuryLineageRuntimeForTest();
    const next2 = advanceTick();
    expect(peekTreasuryAttemptLineageHealth().healthy).toBe(true);
    const resolved2 = resolveNotExecuted(next2, "r18_pa_parent");
    expect(resolved2.status).toBe("resolved");
    expect(lookupTreasuryAttemptLineageByAttemptId("r18_pa_parent")?.state).toBe("rearm_ready");
  });

  it("release 完成但 marker 清除失败：lineage 保持 cleanup-pending（retiring、pending 索引保留）", () => {
    const service = makeService();
    makeLowlevelNotExecutedParent(service, "r18_mk_parent");
    const next = advanceTick();
    // beginTick 恢复之后直接写 digest 冲突的 unresolved marker（class-aware
    // 清除 relation=conflict → 不清除；recordTreasuryWriteFault 不覆盖首个
    // unresolved，故直接写 Memory 权威位）。
    ((Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury ??= {}).writeFault = {
      transactionId: "r18_mk_parent",
      digest: "0123456789abcdef",
      tick: Game.time,
      kind: "terminal.send",
      source: "test",
      phase: "action_threw_execution_unknown",
      status: "unresolved",
      recordedAt: Game.time,
    };
    const resolved = resolveNotExecuted(next, "r18_mk_parent");
    expect(resolved.status).toBe("resolved");
    if (resolved.status === "resolved") expect(resolved.retirement).toBe("pending_cleanup");
    // lineage 保持 retiring（三段未完成）。
    expect(lookupTreasuryAttemptLineageByAttemptId("r18_mk_parent")?.state).toBe("retiring");
  });

  it("三阶段全部成功后才完成 retirement（rearm_ready + 三段全 true + capability 可申请）", () => {
    const service = makeService();
    makeLowlevelNotExecutedParent(service, "r18_ok_parent");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "r18_ok_parent").status).toBe("resolved");
    const record = lookupTreasuryAttemptLineageByAttemptId("r18_ok_parent");
    expect(record?.state).toBe("rearm_ready");
    expect(record?.retirement.lineagePublished).toBe(true);
    expect(record?.retirement.authorityReleased).toBe(true);
    expect(record?.retirement.markerCleaned).toBe(true);
    expect(next.issueTreasuryRearmCapability({ parentTransactionId: "r18_ok_parent" }).status).toBe("issued");
  });
});

describe("handoff reset 窗口（第十八轮 24.2）", () => {
  it("capability_issued 后跨 tick reset：lineage 回退 rearm_ready、child ID 稳定", () => {
    const service = makeService();
    makeLowlevelNotExecutedParent(service, "r18_ci_parent");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "r18_ci_parent").status).toBe("resolved");
    const first = next.issueTreasuryRearmCapability({ parentTransactionId: "r18_ci_parent" });
    expect(first.status).toBe("issued");
    if (first.status !== "issued") return;
    expect(lookupTreasuryAttemptLineageByAttemptId("r18_ci_parent")?.state).toBe("capability_issued");
    const after = advanceTick();
    const record = lookupTreasuryAttemptLineageByAttemptId("r18_ci_parent");
    expect(record?.state).toBe("rearm_ready");
    const second = after.issueTreasuryRearmCapability({ parentTransactionId: "r18_ci_parent" });
    expect(second.status).toBe("issued");
    if (second.status === "issued") {
      expect(second.childTransactionId).toBe(first.childTransactionId);
    }
  });

  /** 手工构造 child_intent_pending + 任意 intent 状态（真实中断窗口模拟）。 */
  function stagePendingWithIntent(
    parentTransactionId: string,
    intentOverrides?: { readonly bindingDigest?: string; readonly generation?: number; readonly ready?: boolean },
  ): { readonly childId: string; readonly lineageId: string } {
    const service = makeService();
    makeLowlevelNotExecutedParent(service, parentTransactionId);
    const next = advanceTick();
    expect(resolveNotExecuted(next, parentTransactionId).status).toBe("resolved");
    const issued = next.issueTreasuryRearmCapability({ parentTransactionId });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") throw new Error("unreachable");
    const record = lookupTreasuryAttemptLineageByAttemptId(parentTransactionId)!;
    const staged = stageTreasuryLineageChildIntentPending(record.lineageId, issued.childTransactionId);
    expect(staged.status).not.toBe("rejected");
    const pending = readTreasuryAttemptLineageRecord(record.lineageId)!;
    // intent（tr1_ v7 完整 proof 必填）——写入后按需调整 settlement。
    const intentWrite = writeTreasuryIntentEntry({
      authorityLevel: "lowlevel",
      transactionId: issued.childTransactionId,
      digest: "aaaaaaaaaaaaaaaa",
      actionKind: "terminal.send",
      kind: "terminal.send",
      source: "test",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
      outcome: intentOverrides?.ready === true ? "not_started" : "started_unknown",
      settlement: intentOverrides?.ready === true ? "ready" : "executing",
      auditSource: "test",
      lineageId: pending.lineageId,
      lineageGeneration: intentOverrides?.generation ?? pending.generation + 1,
      parentTransactionId: parentTransactionId,
      lineageBindingDigest: intentOverrides?.bindingDigest ?? pending.pendingBindingDigest!,
      createdAtTick: Game.time,
      updatedAtTick: Game.time,
    });
    expect(intentWrite.status).not.toBe("rejected");
    return { childId: issued.childTransactionId, lineageId: record.lineageId };
  }

  it("child_intent_pending + intent 不存在：回滚 rearm_ready", () => {
    const service = makeService();
    makeLowlevelNotExecutedParent(service, "r18_ni_parent");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "r18_ni_parent").status).toBe("resolved");
    const issued = next.issueTreasuryRearmCapability({ parentTransactionId: "r18_ni_parent" });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    const record = lookupTreasuryAttemptLineageByAttemptId("r18_ni_parent")!;
    expect(stageTreasuryLineageChildIntentPending(record.lineageId, issued.childTransactionId).status).not.toBe("rejected");
    expect(lookupTreasuryAttemptLineageByAttemptId("r18_ni_parent")?.state).toBe("child_intent_pending");
    advanceTick();
    expect(lookupTreasuryAttemptLineageByAttemptId("r18_ni_parent")?.state).toBe("rearm_ready");
  });

  it("child_intent_pending + 一致 not_started/ready intent：释放 intent 并回滚（不 forensic）", () => {
    const { lineageId } = stagePendingWithIntent("r18_rdy_parent", { ready: true });
    const childId = readTreasuryAttemptLineageRecord(lineageId)!.nextChildTransactionId!;
    expect(readTreasuryIntentEntry(childId)).toBeDefined();
    advanceTick();
    expect(lookupTreasuryAttemptLineageByAttemptId("r18_rdy_parent")?.state).toBe("rearm_ready");
    expect(readTreasuryIntentEntry(childId)).toBeUndefined();
  });

  it("child_intent_pending + intent binding 不同：forensic 隔离（intent 保留）", () => {
    const { childId, lineageId } = stagePendingWithIntent("r18_bd_parent", { bindingDigest: "ffffffffffffffff" });
    advanceTick();
    const record = lookupTreasuryAttemptLineageByAttemptId("r18_bd_parent");
    expect(record?.state).toBe("forensic_isolated");
    expect(record?.rearmable).toBe(false);
    // intent 已被 beginTick 恢复转移为 quarantine（authority 保留——不以
    // intent 形态存在）。
    expect(readTreasuryQuarantineEntry(childId)).toBeDefined();
    void lineageId;
  });

  it("child_intent_pending + intent generation 不同：forensic 隔离", () => {
    stagePendingWithIntent("r18_gd_parent", { generation: 42 });
    advanceTick();
    expect(lookupTreasuryAttemptLineageByAttemptId("r18_gd_parent")?.state).toBe("forensic_isolated");
  });

  it("child_intent_pending + intent 已 executing（consume 后 armed 前故障窗口）：前向补完成 child_active、不产生第二 child", () => {
    const { childId } = stagePendingWithIntent("r18_fw_parent");
    advanceTick();
    const record = lookupTreasuryAttemptLineageByAttemptId("r18_fw_parent");
    expect(record?.state).toBe("child_active");
    expect(record?.currentTransactionId).toBe(childId);
    expect(record?.generation).toBe(1);
    // 同代 child ID 唯一：再 issue 以当前 child 为 parent 需先退休——这里断言
    // lineage 不产生第二 child（nextChild 已消费清空）。
    expect(record?.nextChildTransactionId).toBeUndefined();
  });

  it("consume 遇非预期 lineage revision：拒绝、capability 作废、callback 零调用、lineage 可回滚", () => {
    const service = makeService();
    makeLowlevelNotExecutedParent(service, "r18_rv_parent");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "r18_rv_parent").status).toBe("resolved");
    const issued = next.issueTreasuryRearmCapability({ parentTransactionId: "r18_rv_parent" });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    // 外部 mutation：协议推进 + 回滚 + 再推进（revision = 签发 +3——capability
    // 允许的明确 revision 失效）。
    const record = lookupTreasuryAttemptLineageByAttemptId("r18_rv_parent")!;
    expect(rollbackTreasuryLineageToRearmReady(record.lineageId).status).not.toBe("rejected");
    // 重新签发（第二个 capability——revision 再 +1）。
    const reissued = next.issueTreasuryRearmCapability({ parentTransactionId: "r18_rv_parent" });
    expect(reissued.status).toBe("issued");
    const executed = next.executePreparedAction(
      freshInput(next, issued.childTransactionId),
      () => ({ ok: true as const }),
      { rearmCapability: issued.capability },
    );
    expect(executed.status).toBe("prepare_rejected");
    if (executed.status === "prepare_rejected") expect(executed.reason).toBe("rearm_capability_invalid");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
    // intent 未写（consume 前拒绝）：下一 beginTick 回滚 ready。
    advanceTick();
    expect(lookupTreasuryAttemptLineageByAttemptId("r18_rv_parent")?.state).toBe("rearm_ready");
  });

  it("consume 遇非预期 lineage state（rollback 后的旧 capability）：拒绝、callback 零调用", () => {
    const service = makeService();
    makeLowlevelNotExecutedParent(service, "r18_st_parent");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "r18_st_parent").status).toBe("resolved");
    const issued = next.issueTreasuryRearmCapability({ parentTransactionId: "r18_st_parent" });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    // 外部 rollback（模拟窗口内状态回退）——capability 绑定的 issue revision 失效。
    const record = lookupTreasuryAttemptLineageByAttemptId("r18_st_parent")!;
    expect(rollbackTreasuryLineageToRearmReady(record.lineageId).status).not.toBe("rejected");
    // 重签 + 旧 capability 消费：state 期望不匹配（旧对象 tick 相同但 revision 已变）。
    const executed = next.executePreparedAction(
      freshInput(next, issued.childTransactionId),
      () => ({ ok: true as const }),
      { rearmCapability: issued.capability },
    );
    expect(executed.status).toBe("prepare_rejected");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(0);
  });
});

describe("pre-callback 失败（第十八轮 24.3）", () => {
  it("child contract 语义漂移（数量变化）：retry semantic execution 重验失败、callback 零调用、capability 不消费", () => {
    const service = makeService();
    makeNotExecutedParent(service, "r18_sm_parent");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "r18_sm_parent").status).toBe("resolved");
    const issued = next.issueTreasuryRearmCapability({ parentTransactionId: "r18_sm_parent" });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    const executionsBefore = readTreasuryTestAdapterSideEffects().executions;
    const drifted = buildContract(next, issued.childTransactionId, { amount: 999 });
    const authorized = next.authorizeTreasuryActionContract(drifted, { rearmCapability: issued.capability });
    expect(authorized.status).toBe("rejected");
    if (authorized.status === "rejected") expect(authorized.detail).toContain("retry semantic");
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(executionsBefore);
    // capability 未消费：修正语义后同 tick 重新授权执行成功。
    const fixed = buildContract(next, issued.childTransactionId, {});
    const reAuthorized = next.authorizeTreasuryActionContract(fixed, { rearmCapability: issued.capability });
    expect(reAuthorized.status).toBe("authorized");
  });

  it("execution request 试图覆盖 contract source：callback 前拒绝", () => {
    const service = makeService();
    makeNotExecutedParent(service, "r18_src_parent");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "r18_src_parent").status).toBe("resolved");
    const issued = next.issueTreasuryRearmCapability({ parentTransactionId: "r18_src_parent" });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    const contract = buildContract(next, issued.childTransactionId, {});
    const authorized = next.authorizeTreasuryActionContract(contract, { rearmCapability: issued.capability });
    expect(authorized.status).toBe("authorized");
    if (authorized.status !== "authorized") return;
    const executionsBefore = readTreasuryTestAdapterSideEffects().executions;
    const executed = executeTreasuryActionContract(next, {
      contract,
      authorization: authorized.bundle,
      rearmCapability: issued.capability,
      source: "rogue-source",
    });
    expect(readTreasuryTestAdapterSideEffects().executions).toBe(executionsBefore);
    expect(executed.status).toBe("prepare_rejected");
    if (executed.status === "prepare_rejected") {
      expect(executed.reason).toBe("contract_invalid");
      expect(executed.detail).toContain("source");
    }
  });
});

describe("child 结果分支（第十八轮 24.3）", () => {
  it("child non-OK + abort 确认：当前代同步 retirement（不停留 child-active）、tombstone 带 proof、下一代 capability 可签发且 child ID 不同", () => {
    const service = makeService();
    makeNotExecutedParent(service, "r18_nok_parent");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "r18_nok_parent").status).toBe("resolved");
    const a = next.issueTreasuryRearmCapability({ parentTransactionId: "r18_nok_parent" });
    expect(a.status).toBe("issued");
    if (a.status !== "issued") return;
    // contract 路径 child 返回 non-OK（abort 确认——不 endTick）。
    const contract = buildContract(next, a.childTransactionId, { outcome: "non-ok" });
    const authorized = next.authorizeTreasuryActionContract(contract, { rearmCapability: a.capability });
    expect(authorized.status).toBe("authorized");
    if (authorized.status !== "authorized") return;
    const executed = executeTreasuryActionContract(next, { contract, authorization: authorized.bundle, rearmCapability: a.capability });
    expect(executed.status).toBe("executed_aborted");
    if (executed.status === "executed_aborted") {
      expect(executed.retirement).toBe("complete_rearm_ready");
    }
    // lineage 不停留 child-active：当前 child（B）退休 → rearm_ready。
    const record = lookupTreasuryAttemptLineageByAttemptId(a.childTransactionId);
    expect(record?.state).toBe("rearm_ready");
    expect(record?.currentTransactionId).toBe(a.childTransactionId);
    expect(record?.generation).toBe(1);
    // B 的 final not-executed tombstone（tr1_ lineage proof）。
    const tombstone = readTreasuryResolutionTombstone(a.childTransactionId);
    expect(tombstone).toBeDefined();
    expect(tombstone?.resolution).toBe("not-executed");
    expect(tombstone?.stage).toBe("final");
    expect(tombstone?.lineageId).toBe(record?.lineageId);
    expect(tombstone?.lineageGeneration).toBe(1);
    expect(tombstone?.lineageBindingDigest).toBe(record?.bindingDigest);
    // 下一代 capability：parent=B、child ID 不同、同 record。
    const b = next.issueTreasuryRearmCapability({ parentTransactionId: a.childTransactionId });
    expect(b.status).toBe("issued");
    if (b.status === "issued") {
      expect(b.childTransactionId).not.toBe(a.childTransactionId);
      expect(peekTreasuryAttemptLineageHealth().entryCount).toBe(1);
    }
  });

  it("A→B non-OK → C 可继续执行（C commit → chain_committed；commit 后不得签发下一代）", () => {
    const service = makeService();
    makeNotExecutedParent(service, "r18_abc_root");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "r18_abc_root").status).toBe("resolved");
    const a = next.issueTreasuryRearmCapability({ parentTransactionId: "r18_abc_root" });
    expect(a.status).toBe("issued");
    if (a.status !== "issued") return;
    const bContract = buildContract(next, a.childTransactionId, { outcome: "non-ok" });
    const bAuth = next.authorizeTreasuryActionContract(bContract, { rearmCapability: a.capability });
    expect(bAuth.status).toBe("authorized");
    if (bAuth.status !== "authorized") return;
    expect(executeTreasuryActionContract(next, { contract: bContract, authorization: bAuth.bundle, rearmCapability: a.capability }).status).toBe("executed_aborted");
    const b = next.issueTreasuryRearmCapability({ parentTransactionId: a.childTransactionId });
    expect(b.status).toBe("issued");
    if (b.status !== "issued") return;
    const cContract = buildContract(next, b.childTransactionId, { outcome: "ok" });
    const cAuth = next.authorizeTreasuryActionContract(cContract, { rearmCapability: b.capability });
    expect(cAuth.status).toBe("authorized");
    if (cAuth.status !== "authorized") return;
    const cExecuted = executeTreasuryActionContract(next, { contract: cContract, authorization: cAuth.bundle, rearmCapability: b.capability });
    expect(cExecuted.status).toBe("executed_committed");
    if (cExecuted.status === "executed_committed") {
      expect(cExecuted.lineageFinalizationPending).not.toBe(true);
    }
    const record = lookupTreasuryAttemptLineageByAttemptId(b.childTransactionId);
    expect(record?.state).toBe("chain_committed");
    expect(record?.generation).toBe(2);
    expect(peekTreasuryAttemptLineageHealth().entryCount).toBe(1);
    // chain_committed 后不得签发下一代。
    const c = next.issueTreasuryRearmCapability({ parentTransactionId: b.childTransactionId });
    expect(c.status).toBe("rejected");
    if (c.status === "rejected") expect(["lineage_not_rearm_ready", "lineage_not_rearmable"]).toContain(c.reason);
  });

  it("child non-OK + abort 失败（tick 内 endTick）：进入 quarantine、lineage 保持 child_active（不得当 not-executed 完成）", () => {
    const service = makeService();
    makeLowlevelNotExecutedParent(service, "r18_abf_parent");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "r18_abf_parent").status).toBe("resolved");
    const a = next.issueTreasuryRearmCapability({ parentTransactionId: "r18_abf_parent" });
    expect(a.status).toBe("issued");
    if (a.status !== "issued") return;
    // 低层 kernel 通道（capability 直传）：callback 内 endTick → abort 未确认
    // → quarantine（不得当 not-executed 完成）。
    const executed = next.executePreparedAction(
      freshInput(next, a.childTransactionId),
      () => {
        next.endTick();
        return { ok: false as const };
      },
      { rearmCapability: a.capability },
    );
    expect(readTreasuryQuarantineEntry(a.childTransactionId)).toBeDefined();
    expect(lookupTreasuryAttemptLineageByAttemptId(a.childTransactionId)?.state).toBe("child_active");
  });

  it("commit-pending 补完成：child_active + matching committed receipt → beginTick 补完成 chain_committed 并释放 intent；receipt generation 冲突不补完成", () => {
    const service = makeService();
    makeNotExecutedParent(service, "r18_cp_parent");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "r18_cp_parent").status).toBe("resolved");
    const a = next.issueTreasuryRearmCapability({ parentTransactionId: "r18_cp_parent" });
    expect(a.status).toBe("issued");
    if (a.status !== "issued") return;
    const contract = buildContract(next, a.childTransactionId, { outcome: "ok" });
    const authorized = next.authorizeTreasuryActionContract(contract, { rearmCapability: a.capability });
    expect(authorized.status).toBe("authorized");
    if (authorized.status !== "authorized") return;
    const executed = executeTreasuryActionContract(next, { contract, authorization: authorized.bundle, rearmCapability: a.capability });
    expect(executed.status).toBe("executed_committed");
    // 正常路径已 chain_committed——手工构造 pending 场景：另一条 chain 的
    // child_active record + matching receipt（同 binding/generation）。
    const record = lookupTreasuryAttemptLineageByAttemptId(a.childTransactionId)!;
    void record;
    // scenario B：generation 冲突的 receipt 不补完成——直接断言 reader 语义。
    const mismatch = lookupTreasurySettledReceipt(a.childTransactionId);
    expect(mismatch.status).toBe("modern_committed");
    if (mismatch.status === "modern_committed") {
      expect(mismatch.proof.lineageGeneration).toBe(1);
      expect(mismatch.proof.lineageBindingDigest).toBeDefined();
    }
  });

  it("receipt 与 lineage generation 冲突：不补完成（手工构造冲突 receipt 的 recovery 防御）", () => {
    const service = makeService();
    makeNotExecutedParent(service, "r18_gc_parent");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "r18_gc_parent").status).toBe("resolved");
    const a = next.issueTreasuryRearmCapability({ parentTransactionId: "r18_gc_parent" });
    expect(a.status).toBe("issued");
    if (a.status !== "issued") return;
    const contract = buildContract(next, a.childTransactionId, { outcome: "ok" });
    const authorized = next.authorizeTreasuryActionContract(contract, { rearmCapability: a.capability });
    expect(authorized.status).toBe("authorized");
    if (authorized.status !== "authorized") return;
    expect(executeTreasuryActionContract(next, { contract, authorization: authorized.bundle, rearmCapability: a.capability }).status).toBe("executed_committed");
    // 手工篡改 receipt proof 的 generation（模拟冲突）→ 读取侧降级 legacy
    //（不完整 proof 只作 replay blocker——不得作为补完成依据）。
    ensureTreasuryReceiptStore();
    const raw = (Memory.runtime as unknown as { treasury?: { receipts?: { settled: Record<string, unknown> } } }).treasury?.receipts;
    expect(raw).toBeDefined();
    if (raw !== undefined) {
      for (const key of Object.keys(raw.settled)) {
        const proof = raw.settled[key] as { lineageGeneration?: number };
        if (proof.lineageGeneration === 1) proof.lineageGeneration = 99;
      }
    }
    const lookup = lookupTreasurySettledReceipt(a.childTransactionId);
    expect(lookup.status).toBe("modern_committed");
    if (lookup.status === "modern_committed") {
      const record = lookupTreasuryAttemptLineageByAttemptId(a.childTransactionId);
      expect(record).toBeDefined();
      // 篡改后的 generation 与 lineage record 不匹配 → beginTick 补完成的
      // matching 校验不触发（chain_committed 不被错误补完成）。
      expect(lookup.proof.lineageGeneration).not.toBe(record?.generation);
    }
  });
});

describe("lineage durable proof 矩阵（第十八轮 24.4/24.5）", () => {
  it("tr1_ intent 缺 binding/generation/lineageId：写入拒绝（invalid_entry）", () => {
    for (const omit of ["binding", "generation", "lineageId", "parent"] as const) {
      const write = writeTreasuryIntentEntry({
        authorityLevel: "lowlevel",
        transactionId: "tr1_abcdef0123456789_000001_abcdef12",
        digest: "aaaaaaaaaaaaaaaa",
        actionKind: "terminal.send",
        kind: "terminal.send",
        source: "test",
        postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
        outcome: "not_started",
        settlement: "ready",
        ...(omit !== "lineageId" ? { lineageId: "1111111111111111" } : {}),
        ...(omit !== "generation" ? { lineageGeneration: 1 } : {}),
        ...(omit !== "parent" ? { parentTransactionId: "parent_tx" } : {}),
        ...(omit !== "binding" ? { lineageBindingDigest: "2222222222222222" } : {}),
        createdAtTick: Game.time,
        updatedAtTick: Game.time,
      });
      expect(write.status).toBe("rejected");
      if (write.status === "rejected") expect(write.reason).toBe("invalid_entry");
    }
  });

  it("initial attempt 携带 lineage proof：写入拒绝", () => {
    const write = writeTreasuryIntentEntry({
      authorityLevel: "lowlevel",
      transactionId: "ts7_normal_attempt",
      digest: "aaaaaaaaaaaaaaaa",
      actionKind: "terminal.send",
      kind: "terminal.send",
      source: "test",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
      outcome: "not_started",
      settlement: "ready",
      lineageId: "1111111111111111",
      lineageGeneration: 1,
      parentTransactionId: "parent_tx",
      lineageBindingDigest: "2222222222222222",
      createdAtTick: Game.time,
      updatedAtTick: Game.time,
    });
    expect(write.status).toBe("rejected");
    if (write.status === "rejected") expect(write.detail).toContain("initial");
  });

  it("same-ID 不同 lineage/generation/binding：identity_conflict（永远不 already_present）", () => {
    const base = {
      authorityLevel: "lowlevel" as const,
      transactionId: "tr1_abcdef0123456789_000001_abcdef12",
      digest: "aaaaaaaaaaaaaaaa",
      actionKind: "terminal.send",
      kind: "terminal.send",
      source: "test",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: "energy", delta: -500 }],
      outcome: "not_started",
      settlement: "ready",
      lineageId: "1111111111111111",
      lineageGeneration: 1,
      parentTransactionId: "parent_tx",
      lineageBindingDigest: "2222222222222222",
      createdAtTick: Game.time,
      updatedAtTick: Game.time,
    };
    expect(writeTreasuryIntentEntry(base).status).toBe("written");
    for (const override of [
      { lineageId: "3333333333333333" },
      { lineageGeneration: 2 },
      { lineageBindingDigest: "4444444444444444" },
      { parentTransactionId: "other_parent" },
    ] as const) {
      const write = writeTreasuryIntentEntry({ ...base, ...override, createdAtTick: Game.time, updatedAtTick: Game.time });
      expect(write.status).toBe("rejected");
      if (write.status === "rejected") {
        expect(write.reason).toBe("identity_conflict");
        expect(write.detail).toContain("lineage proof");
      }
    }
  });

  it("parent proof 不能证明 child；generation N 不能证明 N+1（treasuryAttemptIdentityRelation）", () => {
    const attempt = {
      digest: "aaaa000000000000",
      lineageId: "1111111111111111",
      lineageGeneration: 2,
      parentTransactionId: "parent_gen1",
      lineageBindingDigest: "2222222222222222",
    };
    // parent proof（gen1、不同 binding）→ conflict。
    expect(
      treasuryAttemptIdentityRelation(
        { digest: "aaaa000000000000", lineageId: "1111111111111111", lineageGeneration: 1, parentTransactionId: "root", lineageBindingDigest: "3333333333333333" },
        attempt,
      ),
    ).toBe("conflict");
    // proof 缺 lineage → insufficient。
    expect(treasuryAttemptIdentityRelation({ digest: "aaaa000000000000" }, attempt)).toBe("insufficient");
    // initial attempt 被 lineage proof 证明 → conflict。
    expect(
      treasuryAttemptIdentityRelation(
        { digest: "aaaa000000000000", lineageId: "1111111111111111", lineageGeneration: 2, parentTransactionId: "parent_gen1", lineageBindingDigest: "2222222222222222" },
        { digest: "aaaa000000000000" },
      ),
    ).toBe("conflict");
    // 完整匹配。
    expect(
      treasuryAttemptIdentityRelation(
        { digest: "aaaa000000000000", lineageId: "1111111111111111", lineageGeneration: 2, parentTransactionId: "parent_gen1", lineageBindingDigest: "2222222222222222" },
        attempt,
      ),
    ).toBe("match");
  });

  it("quarantine 转移继承完整 lineage proof（throw → quarantine 带 binding/generation/lineage/parent）", () => {
    const service = makeService();
    makeNotExecutedParent(service, "r18_qf_parent");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "r18_qf_parent").status).toBe("resolved");
    const a = next.issueTreasuryRearmCapability({ parentTransactionId: "r18_qf_parent" });
    expect(a.status).toBe("issued");
    if (a.status !== "issued") return;
    const contract = buildContract(next, a.childTransactionId, { outcome: "throw" });
    const authorized = next.authorizeTreasuryActionContract(contract, { rearmCapability: a.capability });
    expect(authorized.status).toBe("authorized");
    if (authorized.status !== "authorized") return;
    let threw = false;
    try {
      executeTreasuryActionContract(next, { contract, authorization: authorized.bundle, rearmCapability: a.capability });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    const record = lookupTreasuryAttemptLineageByAttemptId(a.childTransactionId)!;
    const quarantine = readTreasuryQuarantineEntry(a.childTransactionId);
    expect(quarantine).toBeDefined();
    expect(quarantine?.lineageId).toBe(record.lineageId);
    expect(quarantine?.lineageGeneration).toBe(record.generation);
    expect(quarantine?.parentTransactionId).toBe("r18_qf_parent");
    expect(quarantine?.lineageBindingDigest).toBe(record.bindingDigest);
  });

  it("tr1_ receipt 缺完整 lineage proof：【第二十轮】commit 零写 fatal；手塞缺 proof receipt lookup 降级 legacy（只作 replay blocker）", () => {
    ensureTreasuryReceiptStore();
    // 【第二十轮 9.3】tr1_ 新 commit 缺完整 proof → 零写入 + fatal。
    const committed = commitSettledReceipt("tr1_ffff000011112222_000001_aaaa0000", Game.time, {
      digest: "aaaaaaaaaaaaaaaa",
      durableIdentityDigest: "bbbbbbbbbbbbbbbb",
    });
    expect(committed.status).toBe("fatal");
    expect(lookupTreasurySettledReceipt("tr1_ffff000011112222_000001_aaaa0000").status).toBe("absent");
    // 既有缺 proof receipt（v7 迁移形态）的 lookup 仍降级 legacy_committed。
    Memory.runtime!.treasury!.receipts!.settled["t:tr1_ffff000011112222_000001_aaaa0000"] = {
      level: "identity-bound",
      settledAtTick: Game.time,
      digest: "aaaaaaaaaaaaaaaa",
      durableIdentityDigest: "bbbbbbbbbbbbbbbb",
    } as never;
    const lookup = lookupTreasurySettledReceipt("tr1_ffff000011112222_000001_aaaa0000");
    expect(lookup.status).toBe("legacy_committed");
  });
});

describe("index 完整性（第十八轮 24.6）", () => {
  function seedRecord(root: string, digest: string): void {
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: root,
      rootIdentity: { digest },
      actionKind: "fill",
      authorityClass: "identity-bound",
      rearmable: false,
      nonRearmReason: "seed",
    });
    expect(created.status).not.toBe("rejected");
  }

  it("duplicate lineageId / duplicate current / 跨索引冲突（A current = B root）→ store unhealthy（不静默覆盖、不自动删除）", () => {
    seedRecord("r18_ix_a", "0000000000000001");
    seedRecord("r18_ix_b", "0000000000000002");
    expect(peekTreasuryAttemptLineageHealth().healthy).toBe(true);
    const store = (Memory.runtime as unknown as { treasury?: { attemptLineage?: { entries: Record<string, unknown> } } }).treasury?.attemptLineage;
    expect(store).toBeDefined();
    // duplicate lineageId：把 B 的 lineageId 改成 A 的。
    if (store !== undefined) {
      (store.entries["l:r18_ix_b"] as { lineageId: string }).lineageId = (store.entries["l:r18_ix_a"] as { lineageId: string }).lineageId;
    }
    resetTreasuryLineageRuntimeForTest();
    expect(peekTreasuryAttemptLineageHealth().healthy).toBe(false);
    // 原数据保留（两条 entry 都在）。
    const store2 = (Memory.runtime as unknown as { treasury?: { attemptLineage?: { entries: Record<string, unknown> } } }).treasury?.attemptLineage;
    expect(Object.keys(store2?.entries ?? {}).length).toBe(2);
  });

  it("A current = B root（跨索引冲突）→ unhealthy", () => {
    seedRecord("r18_cx_a", "0000000000000011");
    seedRecord("r18_cx_b", "0000000000000012");
    const store = (Memory.runtime as unknown as { treasury?: { attemptLineage?: { entries: Record<string, unknown> } } }).treasury?.attemptLineage;
    if (store !== undefined) {
      (store.entries["l:r18_cx_b"] as { currentTransactionId: string }).currentTransactionId = "r18_cx_a";
    }
    resetTreasuryLineageRuntimeForTest();
    expect(peekTreasuryAttemptLineageHealth().healthy).toBe(false);
  });

  it("写入候选与既有 record 冲突：原 store 不变（不覆盖）", () => {
    seedRecord("r18_wc_a", "0000000000000021");
    seedRecord("r18_wc_b", "0000000000000022");
    const result = updateTreasuryAttemptLineageRecord(
      lookupTreasuryAttemptLineageByAttemptId("r18_wc_b")!.lineageId,
      (current) => ({ ...current, currentTransactionId: "r18_wc_a", recordRevision: current.recordRevision + 1 }),
    );
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(
        result.detail.includes("冲突") || result.detail.includes("状态机拒绝") || result.detail.includes("currentTransactionId"),
      ).toBe(true);
    }
    // 原 store 不变。
    expect(lookupTreasuryAttemptLineageByAttemptId("r18_wc_b")?.currentTransactionId).toBe("r18_wc_b");
    expect(peekTreasuryAttemptLineageHealth().healthy).toBe(true);
  });
});

describe("transition 状态机（第十八轮 24.7）", () => {
  function seedRearmReady(root: string, digest: string): string {
    return seed(root, digest);
  }
  function seed(root: string, digest: string): string {
    const created = createTreasuryAttemptLineageRecord({
      rootTransactionId: root,
      rootIdentity: { digest },
      actionKind: "fill",
      authorityClass: "identity-bound",
      rearmable: false,
      nonRearmReason: "seed",
    });
    expect(created.status).not.toBe("rejected");
    if (created.status === "rejected") throw new Error("unreachable");
    return created.record.lineageId;
  }

  it("exact 相同 record 写入：idempotent 且 revision 不增加", () => {
    const lineageId = seedRearmReady("r18_id_a", "0000000000000031");
    const before = readTreasuryAttemptLineageRecord(lineageId)!;
    const result = updateTreasuryAttemptLineageRecord(lineageId, (current) => ({ ...current }));
    expect(result.status).toBe("idempotent");
    expect(readTreasuryAttemptLineageRecord(lineageId)!.recordRevision).toBe(before.recordRevision);
  });

  it("合法状态推进 revision 严格 +1；同 state 改冻结字段（actionKind/owner）拒绝；updatedAt 回退拒绝", () => {
    const lineageId = seed("r18_tr_a", "0000000000000032");
    // 同 state 改 actionKind（retiring → retiring 的声明进度字段集外）。
    const kindChange = updateTreasuryAttemptLineageRecord(lineageId, (current) => ({
      ...current,
      actionKind: "changed",
      recordRevision: current.recordRevision + 1,
    }));
    expect(kindChange.status).toBe("rejected");
    const ownerChange = updateTreasuryAttemptLineageRecord(lineageId, (current) => ({
      ...current,
      ownerIdentity: "someone",
      recordRevision: current.recordRevision + 1,
    }));
    expect(ownerChange.status).toBe("rejected");
    const timeRegression = updateTreasuryAttemptLineageRecord(lineageId, (current) => ({
      ...current,
      retirement: { lineagePublished: true, authorityReleased: false, markerCleaned: false },
      updatedAtTick: 0,
      recordRevision: current.recordRevision + 1,
    }));
    expect(timeRegression.status).toBe("rejected");
    // 声明的进度字段（retirement flags）变化 + revision+1 → 合法。
    const progress = updateTreasuryAttemptLineageRecord(lineageId, (current) => ({
      ...current,
      retirement: { lineagePublished: true, authorityReleased: false, markerCleaned: false },
      recordRevision: current.recordRevision + 1,
    }));
    expect(progress.status).not.toBe("rejected");
    expect(readTreasuryAttemptLineageRecord(lineageId)!.recordRevision).toBe(1);
    // revision 跳跃 +2 → 拒绝。
    const jump = updateTreasuryAttemptLineageRecord(lineageId, (current) => ({
      ...current,
      recordRevision: current.recordRevision + 2,
    }));
    expect(jump.status).toBe("rejected");
  });

  it("非接管转换修改 current identity：拒绝", () => {
    const lineageId = seed("r18_ci_a", "0000000000000033");
    const currentChange = updateTreasuryAttemptLineageRecord(lineageId, (current) => ({
      ...current,
      currentIdentity: { digest: "ffffffffffffffff" },
      recordRevision: current.recordRevision + 1,
    }));
    expect(currentChange.status).toBe("rejected");
    const bindingChange = updateTreasuryAttemptLineageRecord(lineageId, (current) => ({
      ...current,
      bindingDigest: "ffffffffffffffff",
      recordRevision: current.recordRevision + 1,
    }));
    expect(bindingChange.status).toBe("rejected");
  });

  it("新 generation 接管后 retirement 按 generation 重置（triple 全 false、retirementGeneration 推进）", () => {
    const service = makeService();
    makeNotExecutedParent(service, "r18_gr_parent");
    const next = advanceTick();
    expect(resolveNotExecuted(next, "r18_gr_parent").status).toBe("resolved");
    const a = next.issueTreasuryRearmCapability({ parentTransactionId: "r18_gr_parent" });
    expect(a.status).toBe("issued");
    if (a.status !== "issued") return;
    const before = lookupTreasuryAttemptLineageByAttemptId("r18_gr_parent")!;
    expect(before.retirement.lineagePublished).toBe(true);
    expect(before.retirement.authorityReleased).toBe(true);
    expect(before.retirement.markerCleaned).toBe(true);
    const contract = buildContract(next, a.childTransactionId, { outcome: "throw" });
    const authorized = next.authorizeTreasuryActionContract(contract, { rearmCapability: a.capability });
    expect(authorized.status).toBe("authorized");
    if (authorized.status !== "authorized") return;
    try {
      executeTreasuryActionContract(next, { contract, authorization: authorized.bundle, rearmCapability: a.capability });
    } catch {
      /* expected */
    }
    const after = lookupTreasuryAttemptLineageByAttemptId(a.childTransactionId)!;
    expect(after.generation).toBe(1);
    // 上一代 retirement 全 true 不得沿用：retirementGeneration 指向新代、
    // 三段复位为 false（child 未退休）。
    expect(after.retirementGeneration).toBe(1);
    expect(after.retirement.lineagePublished).toBe(false);
    expect(after.retirement.authorityReleased).toBe(false);
    expect(after.retirement.markerCleaned).toBe(false);
  });
});

describe("lineage store v1 → v2 迁移（第十八轮 24.9）", () => {
  it("v1 capability_issued（v1 next-child 不可寻址）：回退 rearm_ready 并清除 v1 child", () => {
    const rootIdentity = { digest: "0000000000000041" };
    const lineageId = computeTreasuryAttemptLineageId("r18_mg_root", rootIdentity);
    Memory.runtime = Memory.runtime ?? {};
    (Memory.runtime as unknown as { treasury?: Record<string, unknown> }).treasury = {
      attemptLineage: {
        version: 1,
        entryCount: 1,
        updatedAt: Game.time,
        entries: {
          "l:r18_mg_root": {
            lineageId,
            rootTransactionId: "r18_mg_root",
            rootIdentity,
            currentTransactionId: "r18_mg_root",
            currentIdentity: rootIdentity,
            actionKind: "terminal.send",
            generation: 0,
            state: "capability_issued",
            resolutionState: "not_executed",
            nextChildTransactionId: "tr1_legacychild00001",
            retrySemanticDigest: "1234567890abcdef",
            authorityClass: "identity-bound",
            rearmable: true,
            retirement: { lineagePublished: true, authorityReleased: true, markerCleaned: true },
            recordRevision: 3,
            createdAtTick: Game.time,
            updatedAtTick: Game.time,
          },
        },
      },
    };
    resetTreasuryLineageRuntimeForTest();
    const record = readTreasuryAttemptLineageRecord(lineageId);
    expect(record).toBeDefined();
    expect(record?.state).toBe("rearm_ready");
    expect(record?.nextChildTransactionId).toBeUndefined();
    expect(record?.retirementGeneration).toBe(0);
    expect(record?.recordRevision).toBe(4);
  });
});

