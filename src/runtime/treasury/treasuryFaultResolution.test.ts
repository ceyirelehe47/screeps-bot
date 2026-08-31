/**
 * Treasury 显式 fault resolution 测试（第八轮：staged atomic + capability）：
 * - 结论只能来自 service 签发的 reconciliation capability（注册 reconciler
 *   判定；调用者不可自填 conclusion）；
 * - resolve-as-committed：receipt 以 resolution tick **写入或刷新**（既有
 *   receipt 真正更新到 resolution tick、nextExpiry 同步重算）、actionTick
 *   保留于 tombstone、释放 quarantine/intent、清匹配 marker、防重放（统一
 *   replay horizon：receipt 过期但 committed tombstone 在窗口内仍拒绝新
 *   prepare）、幂等 already_resolved、延迟 5001 tick 完整 retention、global
 *   reset 后可完成；
 * - resolve-as-not-executed：先写 final tombstone 再释放（失败不得形成"可
 *   重新 prepare"中间态）；execution-unknown phase 才允许；commit 类拒绝；
 *   still_uncertain 保持隔离；
 * - capability 防伪：普通对象伪造、跨 tick、旧 service generation 一律拒绝；
 *   active handle / 同 tick / 未注册 reconciler 在签发侧拒绝；
 * - staged 故障注入：resolution slot 满零状态变化；resolving 中断后
 *   beginTick 幂等恢复（receipt 已写→finalize；无进展→回滚；final 未释放
 *   →补完成）；resolution store v2 损坏 fail closed；
 * - 显式 repair（quarantine 元数据）。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest, hasSettledReceipt, peekTreasuryReceiptStore, readTreasurySettlementProof } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { computeTreasuryDurableIdentityDigest } from "@/runtime/treasury/durableIdentity";
import {
  readTreasuryWriteFault,
  setTreasuryCommitFaultInjectorForTest,
  type TreasuryWriteFaultPhase,
} from "@/runtime/treasury/writeFault";
import { readTreasuryQuarantineEntry, treasuryQuarantineBlockers, resetTreasuryQuarantineRuntimeForTest, TREASURY_QUARANTINE_MAX_ENTRIES, type TreasuryQuarantineStore } from "@/runtime/treasury/quarantine";
import {
  resolveTreasuryQuarantinedTransactionAsCommitted,
  resolveTreasuryQuarantinedTransactionAsNotExecuted,
  repairTreasuryQuarantineStoreForResolution,
} from "@/runtime/treasury/faultResolution";
import {
  ensureTreasuryResolutionStoreValidated,
  peekTreasuryResolutionStoreHealth,
  readTreasuryResolutionTombstone,
  resetTreasuryResolutionStoreForTest,
  writeTreasuryResolutionTombstone,
  TREASURY_RESOLUTION_MAX_ENTRIES,
} from "@/runtime/treasury/resolutionStore";
import {
  makeTreasuryTestTransferAdapter,
  replaceTreasuryActionAdapterForTest,
  unregisterTreasuryActionAdapterForTest,
  type TreasuryActionReconcilerConclusion,
} from "@/runtime/treasury/actionContracts";
import type { TreasuryReconciliationCapability } from "@/runtime/treasury/reconciliation";
import { peekTreasuryQuarantineHealth, quarantineTreasuryTransaction } from "@/runtime/treasury/quarantine";
import { readTreasuryIntentEntry, writeTreasuryIntentEntry, migrateTreasuryLegacyIntentPhase } from "@/runtime/treasury/intents";
import { resetTreasuryIntentRuntimeForTest } from "@/runtime/treasury/intents";
import { installRooms, type RoomSpec } from "@mock/treasury";
import type { TreasuryTransactionInput } from "@/runtime/treasury/types";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";

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
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta }],
  };
}

function injectOnce(phase: TreasuryWriteFaultPhase): void {
  let fired = false;
  setTreasuryCommitFaultInjectorForTest((candidate) => {
    if (candidate === phase && !fired) {
      fired = true;
      throw new Error(`injected:${phase}`);
    }
  });
}

/** 测试 reconciler 的可编排结论（结论只能来自注册 reconciler）。 */
let reconcilerConclusion: TreasuryActionReconcilerConclusion = "observed_committed";

function registerTerminalSendReconciler(): void {
  replaceTreasuryActionAdapterForTest({
    ...makeTreasuryTestTransferAdapter(),
    kind: "terminal.send",
    // 【第十二轮 3.5】语义身份与 kind 一致（authority 写入时绑定的是 registry 当前值）。
    semanticIdentity: "terminal.send@reconciler-semantics-v1",
    reconcile: () => reconcilerConclusion,
  });
}

/** 从 service 签发 capability（结论由 reconcilerConclusion 编排）。 */
function issueCapability(service: TreasuryTestService, transactionId: string, digest?: string):
  | { status: "issued"; capability: TreasuryReconciliationCapability }
  | { status: "rejected"; reason: string; detail: string } {
  const issued = service.issueTreasuryReconciliationCapability({
    transactionId,
    ...(digest !== undefined ? { digest } : {}),
  });
  if (issued.status === "issued") return { status: "issued", capability: issued.capability };
  return { status: "rejected", reason: issued.reason, detail: issued.detail };
}

function resolveCommitted(service: TreasuryTestService, transactionId: string, digest?: string) {
  const issued = issueCapability(service, transactionId, digest);
  if (issued.status === "rejected") return { status: "issuance_rejected" as const, reason: issued.reason, detail: issued.detail };
  return service.resolveUnresolvedTransaction({
    transactionId,
    ...(digest !== undefined ? { digest } : {}),
    capability: issued.capability,
  });
}

function resolveNotExecuted(service: TreasuryTestService, transactionId: string, digest?: string) {
  const issued = issueCapability(service, transactionId, digest);
  if (issued.status === "rejected") return { status: "issuance_rejected" as const, reason: issued.reason, detail: issued.detail };
  return service.resolveUnresolvedTransaction({
    transactionId,
    ...(digest !== undefined ? { digest } : {}),
    capability: issued.capability,
  });
}

/** 制造一笔 commit-fault 后跨 tick 的 quarantine（Game 确认 OK 的故障）。 */
function makeCommittedFaultQuarantine(
  transactionId = "ts1_res_c",
): { faultTick: number; digest: string; contractDigest?: string; authorizationCohortDigest?: string; durableIdentityDigest?: string } {
  const service = makeService();
  injectOnce("receipt_publish");
  const result = service.executePreparedAction(freshInput(service, transactionId), () => ({ ok: true }));
  expect(result.status).toBe("executed_unsettled");
  service.endTick();
  const entry = readTreasuryQuarantineEntry(transactionId);
  expect(entry).toBeDefined();
  // 【第十三轮】返回完整 attempt identity——staged tombstone/receipt fixture
  // 须与 authority 身份一致（identity match 才能释放/刷新）。
  return {
    faultTick: Game.time,
    digest: entry!.digest,
    ...(entry!.contractDigest !== undefined ? { contractDigest: entry!.contractDigest } : {}),
    ...(entry!.authorizationCohortDigest !== undefined
      ? { authorizationCohortDigest: entry!.authorizationCohortDigest }
      : {}),
    ...(entry!.durableIdentityDigest !== undefined ? { durableIdentityDigest: entry!.durableIdentityDigest } : {}),
  };
}

/** 制造一笔 executing 边界 quarantine（Game 结果未知）。 */
function makeExecutingQuarantine(transactionId: string): { digest: string } {
  const service = makeService();
  service.executePreparedAction(freshInput(service, transactionId), () => {
    service.endTick();
    return { ok: false as const };
  });
  const entry = readTreasuryQuarantineEntry(transactionId);
  expect(entry).toBeDefined();
  return { digest: entry!.digest };
}

function advanceTick(): TreasuryTestService {
  Game.time += 1;
  const next = makeService();
  next.beginTick();
  return next;
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  setTreasuryCommitFaultInjectorForTest(null);
  reconcilerConclusion = "observed_committed";
  registerTerminalSendReconciler();
});

afterEach(() => {
  setTreasuryCommitFaultInjectorForTest(null);
});

describe("capability 签发与防伪", () => {
  it("普通对象伪造/跨 tick capability/旧 service generation 一律拒绝", () => {
    const { digest } = makeCommittedFaultQuarantine("cap_forge");
    const next = advanceTick();
    const issued = issueCapability(next, "cap_forge", digest);
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    // 伪造：结构相同的普通对象。
    const forged: TreasuryReconciliationCapability = { ...issued.capability };
    const forgedResult = next.resolveUnresolvedTransaction({
      transactionId: "cap_forge",
      digest,
      capability: forged,
    });
    expect(forgedResult.status).toBe("rejected");
    if (forgedResult.status === "rejected") expect(forgedResult.reason).toBe("invalid_capability");
    // JSON round-trip 副本。
    const roundTrip = JSON.parse(JSON.stringify(issued.capability)) as TreasuryReconciliationCapability;
    const roundTripResult = next.resolveUnresolvedTransaction({
      transactionId: "cap_forge",
      digest,
      capability: roundTrip,
    });
    expect(roundTripResult.status).toBe("rejected");
    // 跨 tick capability：下一 tick 的 resolve 拒绝（须重新签发）。
    Game.time += 1;
    const later = makeService();
    later.beginTick();
    const crossTick = later.resolveUnresolvedTransaction({
      transactionId: "cap_forge",
      digest,
      capability: issued.capability,
    });
    expect(crossTick.status).toBe("rejected");
    if (crossTick.status === "rejected") expect(crossTick.reason).toBe("invalid_capability");
    // 旧 service generation：新实例的 resolve 用旧 capability 拒绝。
    Game.time += 1;
    const newest = advanceTick();
    const reissued = issueCapability(newest, "cap_forge", digest);
    if (reissued.status === "issued") {
      const crossGen = later.resolveUnresolvedTransaction({
        transactionId: "cap_forge",
        digest,
        capability: reissued.capability,
      });
      expect(crossGen.status).toBe("rejected");
      if (crossGen.status === "rejected") expect(crossGen.reason).toBe("invalid_capability");
    }
    // 重新签发 + 正确 generation → resolved。
    const final = resolveCommitted(newest, "cap_forge", digest);
    expect(final.status).toBe("resolved");
  });

  it("未注册 reconciler 的 action kind：签发拒绝（capability 不可得）", () => {
    const { digest } = makeCommittedFaultQuarantine("cap_noreg");
    unregisterTreasuryActionAdapterForTest("terminal.send");
    const next = advanceTick();
    const rejected = issueCapability(next, "cap_noreg", digest);
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("no_registered_reconciler");
    expect(next.metrics().reconciliationCapabilitiesRejected).toBe(1);
  });

  it("uncertain reconciler：capability 结论 still_uncertain → resolution 保持隔离", () => {
    makeExecutingQuarantine("cap_uncertain");
    reconcilerConclusion = "still_uncertain";
    const next = advanceTick();
    const uncertain = resolveNotExecuted(next, "cap_uncertain");
    expect(uncertain.status).toBe("uncertain");
    expect(readTreasuryQuarantineEntry("cap_uncertain")).toBeDefined();
    expect(readTreasuryResolutionTombstone("cap_uncertain")).toBeUndefined(); // 零副作用
  });

  it("capability 单次使用：同一 capability 第二次 resolve 拒绝", () => {
    const { digest } = makeCommittedFaultQuarantine("cap_single");
    const next = advanceTick();
    const issued = issueCapability(next, "cap_single", digest);
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    const first = next.resolveUnresolvedTransaction({
      transactionId: "cap_single",
      digest,
      capability: issued.capability,
    });
    expect(first.status).toBe("resolved");
    // 已消费：同 capability 重复 resolve（entry 已释放 → not_found 幂等路径）。
    const second = next.resolveUnresolvedTransaction({
      transactionId: "cap_single",
      digest,
      capability: issued.capability,
    });
    // 【第十二轮 3.3】重复调用携带已消费 capability——无法证明 attempt
    // identity（tombstone 为现代 identity 绑定）→ fail closed 拒绝（不幂等）。
    expect(second.status).toBe("rejected");
  });
});

describe("resolve-as-committed（resolution tick 时间协议 + receipt 刷新）", () => {
  it("receipt 使用 resolution tick：actionTick 保留于 tombstone、释放、清 marker、防重放、幂等", () => {
    const { faultTick, digest } = makeCommittedFaultQuarantine();
    const next = advanceTick();
    const resolved = resolveCommitted(next, "ts1_res_c", digest);
    expect(resolved.status).toBe("resolved");
    if (resolved.status === "resolved") {
      expect(resolved.resolution).toBe("committed");
      expect(resolved.receiptWritten).toBe(true); // receipt_publish 故障：receipt 未写，本次补全
      expect(resolved.reprepareAllowed).toBe(false);
      expect(resolved.actionTick).toBe(faultTick); // 原 action tick 审计保留
      expect(resolved.settledAtTick).toBe(Game.time); // retention 起点 = resolution tick
    }
    expect(hasSettledReceipt("ts1_res_c")).toBe(Game.time);
    expect(readTreasuryQuarantineEntry("ts1_res_c")).toBeUndefined();
    expect(readTreasuryWriteFault()).toBeUndefined();
    const tombstone = readTreasuryResolutionTombstone("ts1_res_c");
    expect(tombstone?.stage).toBe("final");
    expect(tombstone?.actionTick).toBe(faultTick);
    const replay = next.prepareTransaction(freshInput(next, "ts1_res_c"));
    expect(replay.status).toBe("already_settled");
    // 重复 resolution 幂等：复用已消费 capability 直接调用（快路径先于
    // capability 校验——resolved 状态不因重复调用改变）。
    const issuedAgain = issueCapability(next, "ts1_res_c", digest);
    expect(issuedAgain.status).toBe("rejected"); // entry 已释放：签发不可得
    const again = next.resolveUnresolvedTransaction({
      transactionId: "ts1_res_c",
      digest,
      capability: { __brand: "treasury-reconciliation-capability" } as never,
    });
    // 【第十二轮 3.3】伪造 capability 无法证明 attempt identity → 拒绝。
    expect(again.status).toBe("rejected");
  });

  it("既有 receipt 真正刷新到 resolution tick（不是 already_settled 短路）", () => {
    // tick1 receipt 已写（正常 commit）后人为入隔离（模拟后续对账争议场景：
    // 直接构造 entry + 既有 receipt 的组合）。
    const service = makeService();
    const committed = service.executePreparedAction(freshInput(service, "ts1_refresh"), () => ({ ok: true }));
    expect(committed.status).toBe("executed_committed");
    expect(hasSettledReceipt("ts1_refresh")).toBe(Game.time); // tick1
    const receiptTickBefore = Game.time;
    // 人为构造同一 id 的 quarantine entry（故障后对账场景的等价前置态；先
    // 建合法 store——正常 commit 路径不产生 quarantine）。
    Memory.runtime!.treasury!.quarantine = { version: 5, entries: {}, entryCount: 0 };
    const store = Memory.runtime!.treasury!.quarantine as unknown as TreasuryQuarantineStore;
    // 【第十三轮】fixture 的 digest 与既有 modern receipt proof 一致
    //（identity-aware refresh：authority 为 digest-only legacy attempt 时按
    // digest 匹配 relation=match 即可刷新；proof 身份保留不降级）。
    const settledProof = readTreasurySettlementProof("ts1_refresh");
    expect(settledProof).toBeDefined();
    const refreshDigest = settledProof!.digest ?? "0123456789abcdef";
    store.entries["q:ts1_refresh"] = {
      transactionId: "ts1_refresh",
      authorityLevel: "lowlevel",
      // 【第十四轮】低层矩阵：durableIdentityDigest 由事实派生 + lowlevelSource
      // 来源标记 + postings 非空（deltas 为空不再可写）。
      // 【第十四轮】低层矩阵：durableIdentityDigest 由事实派生（事实与原
      // transaction 的 freshInput 一致——与既有 receipt proof 的身份匹配）
      // + lowlevelSource 来源标记 + postings 非空（deltas 为空不再可写）。
      lowlevelSource: "runtime-lowlevel@v1",
      durableIdentityDigest: computeTreasuryDurableIdentityDigest({
        transactionId: "ts1_refresh",
        digest: refreshDigest,
        actionKind: "terminal.send",
        postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -500 }],
        source: "test",
        adapterSemanticIdentity: "terminal.send@reconciler-semantics-v1",
      }),
      digest: refreshDigest,
      tick: Game.time,
      kind: "terminal.send",
      adapterSemanticIdentity: "terminal.send@reconciler-semantics-v1",
      source: "test",
      phase: "receipt_publish",
      outcome: "returned_ok",
      settlement: "quarantined",
      deltas: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -500 }],
      recordedAt: Game.time,
    };
    store.entryCount += 1;
    Game.time += 5_000;
    const next = makeService();
    next.beginTick();
    const resolved = resolveCommitted(next, "ts1_refresh", refreshDigest);
    expect(resolved.status).toBe("resolved");
    // receipt 刷新到 resolution tick（旧 tick1 窗口不残留）。
    expect(hasSettledReceipt("ts1_refresh")).toBe(Game.time);
    expect(hasSettledReceipt("ts1_refresh")).not.toBe(receiptTickBefore);
    const storeReceipts = peekTreasuryReceiptStore();
    expect(storeReceipts?.nextExpiryTick).toBe(Game.time + 5_000 + 1);
    expect(next.metrics().receiptRefreshes).toBe(1);
    // 下一 tick cleanup 不删除（新窗口未到）。
    Game.time += 1;
    const after = makeService();
    after.beginTick();
    expect(hasSettledReceipt("ts1_refresh")).toBe(Game.time - 1);
  });

  it("统一 replay horizon：receipt 过期删除但 committed tombstone 在窗口内 → prepare 仍拒绝", () => {
    const { digest } = makeCommittedFaultQuarantine("ts1_horizon");
    const next = advanceTick();
    expect(resolveCommitted(next, "ts1_horizon", digest).status).toBe("resolved");
    // 模拟 receipt retention 过期被清理（tombstone 保留）。
    Game.time += 5_100;
    const later = makeService();
    later.beginTick();
    const store = peekTreasuryReceiptStore();
    if (store) {
      delete (store.settled as unknown as Record<string, number>)["t:ts1_horizon"];
      store.entryCount -= 1;
    }
    expect(hasSettledReceipt("ts1_horizon")).toBeUndefined();
    // tombstone 仍在窗口外？resolvedAtTick = 旧 tick + 5100 已过 —— 但统一
    // horizon 以 settledAtTick+retention 判定：settledAtTick 也旧 → 窗口已过。
    // 将 resolvedAtTick 推回窗口内（等价于"刚 resolve 不久"的时序）。
    const tombstone = Memory.runtime!.treasury!.resolutions!.entries["r:ts1_horizon"];
    tombstone.settledAtTick = Game.time;
    const replay = later.prepareTransaction(freshInput(later, "ts1_horizon"));
    expect(replay.status).toBe("already_settled"); // tombstone 窗口内不当作全新动作
    expect(readTreasuryResolutionTombstone("ts1_horizon")?.resolution).toBe("committed");
    // 【第十二轮 3.3】伪造 capability 无法证明 attempt identity（现代
    // tombstone 绑定 durable identity）→ 重复 resolution fail closed 拒绝。
    const again = later.resolveUnresolvedTransaction({
      transactionId: "ts1_horizon",
      digest,
      capability: { __brand: "treasury-reconciliation-capability" } as never,
    });
    expect(again.status).toBe("rejected");
  });

  it("延迟 5001 tick 后 resolve-as-committed：receipt 仍存活完整 retention 窗口", () => {
    const { digest } = makeCommittedFaultQuarantine("ts1_res_late");
    Game.time += 5_001;
    const next = makeService();
    next.beginTick();
    const resolved = resolveCommitted(next, "ts1_res_late", digest);
    expect(resolved.status).toBe("resolved");
    expect(hasSettledReceipt("ts1_res_late")).toBe(Game.time);
    Game.time += 1;
    const after = makeService();
    after.beginTick();
    expect(hasSettledReceipt("ts1_res_late")).toBe(Game.time - 1);
    expect(peekTreasuryReceiptStore()?.nextExpiryTick).toBe((Game.time - 1) + 5_000 + 1);
  });

  it("global reset 后（service 重建）由新 service 重新签发并完成 resolution", () => {
    const { digest } = makeCommittedFaultQuarantine("ts1_res_reset");
    const next = advanceTick();
    const resolved = resolveCommitted(next, "ts1_res_reset", digest);
    expect(resolved.status).toBe("resolved");
  });
});

describe("resolve-as-not-executed（staged：final tombstone 先行）", () => {
  it("execution-unknown phase：先写 final tombstone 再释放、可重新 prepare（不写 receipt）", () => {
    makeExecutingQuarantine("ts1_ne");
    reconcilerConclusion = "observed_not_executed";
    const next = advanceTick();
    const resolved = resolveNotExecuted(next, "ts1_ne");
    expect(resolved.status).toBe("resolved");
    if (resolved.status === "resolved") {
      expect(resolved.resolution).toBe("not-executed");
      expect(resolved.receiptWritten).toBe(false);
      expect(resolved.reprepareAllowed).toBe(true);
    }
    expect(hasSettledReceipt("ts1_ne")).toBeUndefined();
    expect(readTreasuryQuarantineEntry("ts1_ne")).toBeUndefined();
    expect(readTreasuryResolutionTombstone("ts1_ne")?.stage).toBe("final");
    const reprepared = next.prepareTransaction(freshInput(next, "ts1_ne"));
    expect(reprepared.status).toBe("prepared");
  });

  it("callback 抛错（action_threw_execution_unknown）：uncertain 保持；observed_not_executed 可释放", () => {
    const service = makeService();
    try {
      service.executePreparedAction(freshInput(service, "ts1_threw"), () => {
        throw new Error("boom");
      });
    } catch {
      /* 预期 rethrow */
    }
    expect(readTreasuryQuarantineEntry("ts1_threw")?.phase).toBe("action_threw_execution_unknown");
    reconcilerConclusion = "still_uncertain";
    const mid = advanceTick();
    const uncertain = resolveNotExecuted(mid, "ts1_threw");
    expect(uncertain.status).toBe("uncertain");
    expect(readTreasuryQuarantineEntry("ts1_threw")).toBeDefined();
    reconcilerConclusion = "observed_not_executed";
    const resolved = resolveNotExecuted(mid, "ts1_threw");
    expect(resolved.status).toBe("resolved");
    expect(readTreasuryQuarantineEntry("ts1_threw")).toBeUndefined();
  });

  it("commit 类 phase（Game 已 OK）不允许 not-executed；conclusion 不匹配拒绝", () => {
    const { digest } = makeCommittedFaultQuarantine("ts1_commit_phase");
    reconcilerConclusion = "observed_not_executed";
    const next = advanceTick();
    const rejected = resolveNotExecuted(next, "ts1_commit_phase", digest);
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("resolution_not_allowed");
    // 【第十轮 3.12.8】service 单入口按 conclusion 自动路由：not-executed
    // 结论 + commit 类 authority → not-executed 路径被 outcome 事实拒绝
    //（evidence_mismatch 的显式错配调用不再是生产路径——路由保证结论与
    // resolution 类型恒匹配）。
    const mismatch = resolveCommitted(next, "ts1_commit_phase", digest);
    expect(mismatch.status).toBe("rejected");
    if (mismatch.status === "rejected") expect(mismatch.reason).toBe("resolution_not_allowed");
    // fault 保持不动。
    expect(readTreasuryQuarantineEntry("ts1_commit_phase")).toBeDefined();
    expect(readTreasuryWriteFault()?.transactionId).toBe("ts1_commit_phase");
  });
});

describe("resolution 与 service 状态协调", () => {
  it("active handle 仍存在时签发拒绝；endTick 后放行且不再重新 quarantine", () => {
    const service = makeService();
    injectOnce("receipt_publish");
    const result = service.executePreparedAction(freshInput(service, "ts1_active_handle"), () => ({ ok: true }));
    expect(result.status).toBe("executed_unsettled");
    // 同 tick：handle 仍 active（faulted）→ 签发侧拒绝。
    const rejected = issueCapability(service, "ts1_active_handle");
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("active_handle_present");
    expect(readTreasuryQuarantineEntry("ts1_active_handle")).toBeDefined();
    // 下一 tick：resolution 放行。
    const next = advanceTick();
    const resolved = resolveCommitted(next, "ts1_active_handle");
    expect(resolved.status).toBe("resolved");
    next.endTick();
    expect(readTreasuryQuarantineEntry("ts1_active_handle")).toBeUndefined();
  });

  it("同 tick（未晚于故障 tick）签发拒绝 premature_observation", () => {
    makeExecutingQuarantine("ts1_same_tick");
    const service = makeService(); // 未推进 Game.time
    const rejected = issueCapability(service, "ts1_same_tick");
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("premature_observation");
  });
});

describe("参数校验与不可信 store", () => {
  it("未知 id / digest 不匹配 / malformed input 签发拒绝且 fault 不动", () => {
    const { digest } = makeCommittedFaultQuarantine("ts1_param");
    const next = advanceTick();
    expect(issueCapability(next, "ts1_missing").status).toBe("rejected");
    const mismatch = issueCapability(next, "ts1_param", "ffffffffffffffff");
    expect(mismatch.status).toBe("rejected");
    if (mismatch.status === "rejected") expect(mismatch.reason).toBe("digest_mismatch");
    expect(readTreasuryQuarantineEntry("ts1_param")).toBeDefined();
    // resolve 侧：无 capability 的输入结构化拒绝。
    const malformed = next.resolveUnresolvedTransaction({
      transactionId: "ts1_param",
      capability: undefined as never,
    });
    expect(malformed.status).toBe("rejected");
    if (malformed.status === "rejected") expect(malformed.reason).toBe("invalid_input");
  });

  it("quarantine store 损坏：签发不可得且 resolve 显式拒绝（capability 签发后损坏）", () => {
    const { digest } = makeCommittedFaultQuarantine("ts1_corrupt_store");
    const next = advanceTick();
    const issued = issueCapability(next, "ts1_corrupt_store", digest);
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    // 签发后损坏 store → resolve 显式 quarantine_store_fatal（防御分支）。
    (Memory.runtime!.treasury!.quarantine as unknown as TreasuryQuarantineStore).entryCount = 42;
    resetTreasuryQuarantineRuntimeForTest();
    const rejected = next.resolveUnresolvedTransaction({
      transactionId: "ts1_corrupt_store",
      digest,
      capability: issued.capability,
    });
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("quarantine_store_fatal");
  });

  it("resolution store 损坏：resolve 拒绝（不可信 store 上不得执行）", () => {
    const { digest } = makeCommittedFaultQuarantine("ts1_res_store");
    const next = advanceTick();
    const issued = issueCapability(next, "ts1_res_store", digest);
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    Memory.runtime!.treasury!.resolutions = {
      version: 9,
      entries: {},
      entryCount: 0,
      updatedAt: Game.time,
    } as never;
    resetTreasuryResolutionStoreForTest();
    const rejected = next.resolveUnresolvedTransaction({
      transactionId: "ts1_res_store",
      digest,
      capability: issued.capability,
    });
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("resolution_store_fatal");
    expect(readTreasuryQuarantineEntry("ts1_res_store")).toBeDefined(); // 原状态不动
  });
});

describe("staged atomic（故障注入与恢复）", () => {
  it("resolution slot 满：在任何原状态变化之前拒绝（quarantine/marker/receipt 全不动）", () => {
    const { digest } = makeCommittedFaultQuarantine("ts1_slot_full");
    // 预填满 resolution store（无可清理过期项）。
    for (let index = 0; index < TREASURY_RESOLUTION_MAX_ENTRIES; index += 1) {
      const write = writeTreasuryResolutionTombstone({
        transactionId: `filler${index}`,
        digest: "0123456789abcdef",
        resolution: "committed",
        stage: "final",
        proofLevel: "legacy",
        actionTick: Game.time,
        settledAtTick: Game.time,
        observationTick: Game.time,
        resolvedAtTick: Game.time,
        reconcilerKind: "terminal.send",
      });
      expect(write.status).not.toBe("rejected");
    }
    const next = advanceTick();
    const issued = issueCapability(next, "ts1_slot_full", digest);
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    const rejected = next.resolveUnresolvedTransaction({
      transactionId: "ts1_slot_full",
      digest,
      capability: issued.capability,
    });
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("resolution_store_full");
    // 零状态变化：quarantine/marker/receipt 原样。
    expect(readTreasuryQuarantineEntry("ts1_slot_full")).toBeDefined();
    expect(readTreasuryWriteFault()?.transactionId).toBe("ts1_slot_full");
    expect(hasSettledReceipt("ts1_slot_full")).toBeUndefined();
  });

  it("resolving 中断（receipt 已写）后 beginTick 幂等恢复 finalize", () => {
    const { digest, contractDigest, authorizationCohortDigest, durableIdentityDigest } = makeCommittedFaultQuarantine("ts1_recover");
    // 手工构造 staged 中断态：resolving tombstone + receipt 已写 + quarantine 仍在
    //（【第十三轮】tombstone 绑定 authority 的完整 attempt identity——
    // identity match 才能释放）。
    expect(
      writeTreasuryResolutionTombstone({
        transactionId: "ts1_recover",
        digest,
        resolution: "committed",
        stage: "resolving",
        actionTick: Game.time,
        settledAtTick: Game.time,
        observationTick: Game.time,
        resolvedAtTick: Game.time,
        reconcilerKind: "terminal.send",
        ...(contractDigest !== undefined ? { contractDigest } : {}),
        ...(authorizationCohortDigest !== undefined ? { authorizationCohortDigest } : {}),
        ...(durableIdentityDigest !== undefined ? { durableIdentityDigest } : {}),
        // 【第十四轮】运行时视角的 proof class 推导（与迁移规则不同——迁移对
        // 历史数据保守 forensic，运行时按 authority 事实）：全身份 → identity-
        // bound；durable-only → lowlevel；无身份 → legacy；其余部分 → forensic。
        proofLevel:
          contractDigest !== undefined && authorizationCohortDigest !== undefined && durableIdentityDigest !== undefined
            ? "identity-bound"
            : durableIdentityDigest !== undefined
              ? "lowlevel"
              : contractDigest === undefined && authorizationCohortDigest === undefined
                ? "legacy"
                : "forensic",
      }).status,
    ).not.toBe("rejected");
    const { commitSettledReceipt } = jest.requireActual("@/runtime/treasury/receipts") as typeof import("@/runtime/treasury/receipts");
    expect(
      commitSettledReceipt(
        "ts1_recover",
        Game.time,
        durableIdentityDigest !== undefined ? { digest, durableIdentityDigest } : undefined,
      ).status,
    ).toBe("written");
    expect(readTreasuryQuarantineEntry("ts1_recover")).toBeDefined();
    Game.time += 1;
    const next = makeService();
    next.beginTick(); // 恢复：finalize（释放 quarantine + 清 marker + final）
    expect(readTreasuryResolutionTombstone("ts1_recover")?.stage).toBe("final");
    expect(readTreasuryQuarantineEntry("ts1_recover")).toBeUndefined();
    expect(next.metrics().resolutionRecovered).toBeGreaterThanOrEqual(1);
    expect(next.metrics().resolutionFaulted).toBe(0);
  });

  it("【第九轮 4.9】resolving 无 receipt：beginTick 幂等续做 refresh 至原定 settledAtTick 后 finalize（不回滚不缩短 horizon）", () => {
    const { digest, contractDigest, authorizationCohortDigest, durableIdentityDigest } = makeCommittedFaultQuarantine("ts1_rollback");
    const resolutionTick = Game.time;
    expect(
      writeTreasuryResolutionTombstone({
        transactionId: "ts1_rollback",
        digest,
        resolution: "committed",
        stage: "resolving",
        actionTick: Game.time,
        settledAtTick: resolutionTick,
        observationTick: Game.time,
        resolvedAtTick: Game.time,
        reconcilerKind: "terminal.send",
        ...(contractDigest !== undefined ? { contractDigest } : {}),
        ...(authorizationCohortDigest !== undefined ? { authorizationCohortDigest } : {}),
        ...(durableIdentityDigest !== undefined ? { durableIdentityDigest } : {}),
        // 【第十四轮】运行时视角的 proof class 推导（与迁移规则不同——迁移对
        // 历史数据保守 forensic，运行时按 authority 事实）：全身份 → identity-
        // bound；durable-only → lowlevel；无身份 → legacy；其余部分 → forensic。
        proofLevel:
          contractDigest !== undefined && authorizationCohortDigest !== undefined && durableIdentityDigest !== undefined
            ? "identity-bound"
            : durableIdentityDigest !== undefined
              ? "lowlevel"
              : contractDigest === undefined && authorizationCohortDigest === undefined
                ? "legacy"
                : "forensic",
      }).status,
    ).not.toBe("rejected");
    Game.time += 3; // 跨多个 tick 后恢复。
    const next = makeService();
    next.beginTick(); // 恢复：无 receipt → 幂等续做 refresh（至原定 settledAtTick）→ finalize
    const tombstone = readTreasuryResolutionTombstone("ts1_rollback");
    expect(tombstone?.stage).toBe("final");
    // receipt 刷新到**原定** settledAtTick（不缩短 replay horizon）。
    expect(hasSettledReceipt("ts1_rollback")).toBe(resolutionTick);
    expect(readTreasuryQuarantineEntry("ts1_rollback")).toBeUndefined(); // authority 释放
    expect(next.metrics().resolutionRecovered).toBeGreaterThanOrEqual(1);
  });

  it("【第九轮 4.9】旧 action tick 的 receipt 不被误判为已刷新（续做 refresh 后才 finalize）", () => {
    // 场景：transaction 在故障前已有旧 tick receipt（如 heap_publish 相位），
    // resolving tombstone 写入后 refresh 前 global reset——恢复必须检测
    // receipt tick < settledAtTick 并续做刷新，不得直接 finalize。
    const { digest, contractDigest, authorizationCohortDigest, durableIdentityDigest } = makeCommittedFaultQuarantine("ts1_stale_receipt");
    const { commitSettledReceipt } = jest.requireActual("@/runtime/treasury/receipts") as typeof import("@/runtime/treasury/receipts");
    // 旧 receipt 写在故障 tick（早于 resolution tick；携带该 attempt 的完整
    // 身份——现代 commit 产物为 modern proof）。
    expect(
      commitSettledReceipt(
        "ts1_stale_receipt",
        Game.time,
        durableIdentityDigest !== undefined ? { digest, durableIdentityDigest } : undefined,
      ).status,
    ).toBe("written");
    const staleTick = Game.time;
    Game.time += 1;
    const resolutionTick = Game.time;
    expect(
      writeTreasuryResolutionTombstone({
        transactionId: "ts1_stale_receipt",
        digest,
        resolution: "committed",
        stage: "resolving",
        actionTick: staleTick,
        settledAtTick: resolutionTick,
        observationTick: Game.time,
        resolvedAtTick: Game.time,
        reconcilerKind: "terminal.send",
        ...(contractDigest !== undefined ? { contractDigest } : {}),
        ...(authorizationCohortDigest !== undefined ? { authorizationCohortDigest } : {}),
        ...(durableIdentityDigest !== undefined ? { durableIdentityDigest } : {}),
        // 【第十四轮】运行时视角的 proof class 推导（与迁移规则不同——迁移对
        // 历史数据保守 forensic，运行时按 authority 事实）：全身份 → identity-
        // bound；durable-only → lowlevel；无身份 → legacy；其余部分 → forensic。
        proofLevel:
          contractDigest !== undefined && authorizationCohortDigest !== undefined && durableIdentityDigest !== undefined
            ? "identity-bound"
            : durableIdentityDigest !== undefined
              ? "lowlevel"
              : contractDigest === undefined && authorizationCohortDigest === undefined
                ? "legacy"
                : "forensic",
      }).status,
    ).not.toBe("rejected");
    expect(hasSettledReceipt("ts1_stale_receipt")).toBe(staleTick); // 旧 receipt 仍在
    Game.time += 1;
    const next = makeService();
    next.beginTick(); // 恢复：receipt(staleTick) < settledAtTick → 续做 refresh
    expect(readTreasuryResolutionTombstone("ts1_stale_receipt")?.stage).toBe("final");
    expect(hasSettledReceipt("ts1_stale_receipt")).toBe(resolutionTick); // 刷新到位
    expect(readTreasuryQuarantineEntry("ts1_stale_receipt")).toBeUndefined();
  });

  it("final not-executed 未完成释放：beginTick 补完成（幂等）", () => {
    makeExecutingQuarantine("ts1_release");
    const releaseAuthority = readTreasuryQuarantineEntry("ts1_release")!;
    expect(
      writeTreasuryResolutionTombstone({
        transactionId: "ts1_release",
        digest: releaseAuthority.digest,
        resolution: "not-executed",
        stage: "final",
        actionTick: Game.time,
        observationTick: Game.time,
        resolvedAtTick: Game.time,
        reconcilerKind: "terminal.send",
        ...(releaseAuthority.contractDigest !== undefined ? { contractDigest: releaseAuthority.contractDigest } : {}),
        ...(releaseAuthority.authorizationCohortDigest !== undefined
          ? { authorizationCohortDigest: releaseAuthority.authorizationCohortDigest }
          : {}),
        ...(releaseAuthority.durableIdentityDigest !== undefined
          ? { durableIdentityDigest: releaseAuthority.durableIdentityDigest }
          : {}),
        proofLevel:
          releaseAuthority.authorityLevel === "modern"
            ? "identity-bound"
            : releaseAuthority.authorityLevel === "lowlevel"
              ? "lowlevel"
              : "forensic",
      }).status,
    ).not.toBe("rejected");
    expect(readTreasuryQuarantineEntry("ts1_release")).toBeDefined(); // 释放未完成
    Game.time += 1;
    const next = makeService();
    next.beginTick();
    expect(readTreasuryQuarantineEntry("ts1_release")).toBeUndefined(); // 补完成
  });

  it("resolution store v1 无损升级 v2（补 entryCount/stage=final）", () => {
    Memory.runtime = Memory.runtime ?? {};
    Memory.runtime.treasury = Memory.runtime.treasury ?? {};
    Memory.runtime.treasury.resolutions = {
      version: 1,
      entries: {
        "r:legacy1": {
          transactionId: "legacy1",
          digest: "0123456789abcdef",
          resolution: "committed",
          actionTick: 1,
          settledAtTick: 2,
          observationTick: 2,
          resolvedAtTick: 2,
        } as never,
      },
      updatedAt: 2,
    } as never;
    resetTreasuryResolutionStoreForTest();
    // 显式触发 load（v1 → v2 无损升级在 load 发生；轻量 health 探测不升级）。
    expect(ensureTreasuryResolutionStoreValidated()).toBeNull();
    const health = peekTreasuryResolutionStoreHealth();
    expect(health.healthy).toBe(true);
    expect(readTreasuryResolutionTombstone("legacy1")?.stage).toBe("final");
    expect(Memory.runtime.treasury.resolutions?.version).toBe(4);
    expect(Memory.runtime.treasury.resolutions?.entryCount).toBe(1);
  });
});

describe("显式 repair（quarantine store 元数据/legacy 形状）", () => {
  it("legacy 无版本 + overflowed：repair 验证后恢复健康", () => {
    makeExecutingQuarantine("ts1_repair");
    const store = Memory.runtime!.treasury!.quarantine as unknown as TreasuryQuarantineStore;
    delete (store as { version?: number }).version;
    store.overflowed = true;
    resetTreasuryQuarantineRuntimeForTest();
    const service = makeService();
    service.beginTick();
    expect(peekTreasuryQuarantineHealth().healthy).toBe(false);
    const repaired = repairTreasuryQuarantineStoreForResolution();
    expect(repaired.status).toBe("repaired");
    expect(peekTreasuryQuarantineHealth().healthy).toBe(true);
    expect(peekTreasuryQuarantineHealth().overflowed).toBe(false);
    expect(service.prepareTransaction(freshInput(service, "ts1_after_repair")).status).toBe("rejected"); // quarantine 仍在（阻断直到 resolution）
  });

  it("repair 发现损坏 entry：拒绝且原数据不动", () => {
    makeExecutingQuarantine("ts1_repair_bad");
    const store = Memory.runtime!.treasury!.quarantine as unknown as TreasuryQuarantineStore;
    delete (store as { version?: number }).version;
    (store.entries["q:ts1_repair_bad"] as { digest: string }).digest = "broken";
    resetTreasuryQuarantineRuntimeForTest();
    makeService();
    const rejected = repairTreasuryQuarantineStoreForResolution();
    expect(rejected.status).toBe("rejected");
    expect((Memory.runtime!.treasury!.quarantine as unknown as TreasuryQuarantineStore).entries["q:ts1_repair_bad"]).toBeDefined();
  });

  it("repair 满载 + overflowed：拒绝（先 resolution 再 repair，不掩盖丢 identity）", () => {
    const entries: TreasuryQuarantineStore["entries"] = {};
    for (let index = 0; index < TREASURY_QUARANTINE_MAX_ENTRIES; index += 1) {
      entries[`q:ts1_rp${index}`] = {
        transactionId: `ts1_rp${index}`,
        authorityLevel: "lowlevel",
        digest: "0123456789abcdef",
        tick: Game.time,
        kind: "test",
        source: "test",
        phase: "executing_at_end_tick",
        outcome: "started_unknown",
        settlement: "quarantined",
        deltas: [],
        recordedAt: Game.time,
      };
    }
    Memory.runtime = Memory.runtime ?? {};
    Memory.runtime.treasury = Memory.runtime.treasury ?? {};
    Memory.runtime.treasury.quarantine = {
      version: 1,
      entries,
      entryCount: TREASURY_QUARANTINE_MAX_ENTRIES,
      overflowed: true,
    } as never;
    resetTreasuryQuarantineRuntimeForTest();
    makeService();
    expect(treasuryQuarantineBlockers().blocking).toBe(true);
    expect(repairTreasuryQuarantineStoreForResolution().status).toBe("rejected");
    expect(Object.keys(entries)).toHaveLength(TREASURY_QUARANTINE_MAX_ENTRIES);
  });
});

describe("unified unresolved authority（第九轮 4.7：intent-only 完整参与 + 双权威一致性）", () => {
  /** 直接构造 intent-only authority（quarantine 从未写入——emergency 场景）。 */
  function seedIntentOnly(transactionId: string, legacyPhase: string): void {
    const mapped = migrateTreasuryLegacyIntentPhase(legacyPhase);
    if (mapped === null) throw new Error(`seedIntentOnly: 未知 legacy phase ${legacyPhase}`);
    const write = writeTreasuryIntentEntry({
      transactionId,
      digest: "0123456789abcdef",
      actionKind: "terminal.send",
      kind: "terminal.send",
      adapterSemanticIdentity: "terminal.send@reconciler-semantics-v1",
      source: "test",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -500 }],
      outcome: mapped.outcome,
      settlement: mapped.settlement,
      createdAtTick: Game.time,
      updatedAtTick: Game.time,
    });
    expect(write.status).toBe("written");
  }

  it("intent-only authority（executing 相）可签发 capability 并 resolve-as-committed", () => {
    const service = makeService();
    seedIntentOnly("ua_intent_committed", "executing");
    Game.time += 1;
    const next = makeService();
    next.beginTick();
    const issued = issueCapability(next, "ua_intent_committed");
    expect(issued.status).toBe("issued");
    const resolved = resolveCommitted(next, "ua_intent_committed");
    expect(resolved.status).toBe("resolved");
    // intent 释放 + receipt 以 resolution tick 写入。
    expect(readTreasuryQuarantineEntry("ua_intent_committed")).toBeUndefined();
    expect(readTreasuryIntentEntry("ua_intent_committed")).toBeUndefined();
    expect(hasSettledReceipt("ua_intent_committed")).toBe(Game.time);
  });

  it("intent-only authority phase 允许时（returned_non_ok）可 resolve-as-not-executed", () => {
    const service = makeService();
    seedIntentOnly("ua_intent_notexec", "returned_non_ok");
    Game.time += 1;
    const next = makeService();
    next.beginTick();
    reconcilerConclusion = "observed_not_executed";
    const resolved = resolveNotExecuted(next, "ua_intent_notexec");
    expect(resolved.status).toBe("resolved");
    expect(readTreasuryIntentEntry("ua_intent_notexec")).toBeUndefined();
  });

  it("intent-only authority ok_pending_commit 拒绝 resolve-as-not-executed（事实单调）", () => {
    const service = makeService();
    seedIntentOnly("ua_intent_okphase", "ok_pending_commit");
    Game.time += 1;
    const next = makeService();
    next.beginTick();
    reconcilerConclusion = "observed_not_executed";
    // beginTick 恢复将 ok_pending_commit 转为 commit 类 quarantine（事实等级
    // 保留：ok_pending_commit_unresolved）。
    expect(readTreasuryQuarantineEntry("ua_intent_okphase")?.phase).toBe("ok_pending_commit_unresolved");
    const resolved = resolveNotExecuted(next, "ua_intent_okphase");
    expect(resolved.status).toBe("rejected");
    if (resolved.status === "rejected") expect(resolved.reason).toBe("resolution_not_allowed");
    // authority 原样保留（quarantine 形态——事实单调不降级）。
    expect(readTreasuryQuarantineEntry("ua_intent_okphase")).toBeDefined();
    reconcilerConclusion = "observed_committed";
  });

  it("intent-only authority uncertain 保持隔离（intent 与占用保留）", () => {
    const service = makeService();
    seedIntentOnly("ua_intent_uncertain", "executing");
    Game.time += 1;
    const next = makeService();
    next.beginTick();
    reconcilerConclusion = "still_uncertain";
    // beginTick 恢复转 quarantine（executing→executing_at_end_tick）后，
    // uncertain 仍保持隔离（authority 与占用保留）。
    const resolved = resolveCommitted(next, "ua_intent_uncertain");
    expect(resolved.status).toBe("uncertain");
    expect(readTreasuryQuarantineEntry("ua_intent_uncertain")).toBeDefined();
    reconcilerConclusion = "observed_committed";
  });

  it("同 id 双权威 digest 不一致 fail closed（签发与 resolution 均拒绝）", () => {
    // 双权威须并存到签发时点：先建 service（beginTick 恢复已过）再 seed
    // 双权威，随后 tick+1（不再 beginTick——不触发恢复转换）。
    const next = makeService();
    seedIntentOnly("ua_conflict", "executing");
    // 写入同 id 但 digest 不同的 quarantine entry。
    quarantineTreasuryTransaction({
      transactionId: "ua_conflict",
      digest: "ffffffffffffffff",
      tick: Game.time,
      kind: "terminal.send",
      source: "test",
      phase: "executing_at_end_tick",
      outcome: "started_unknown",
      settlement: "quarantined",
      deltas: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -500 }],
      recordedAt: Game.time,
    });
    Game.time += 1;
    const issued = issueCapability(next, "ua_conflict");
    expect(issued.status).toBe("rejected");
    if (issued.status === "rejected") expect(issued.reason).toBe("authority_inconsistent");
    // resolution 无 capability 可用（签发 fail closed 即阻断）；即使绕过
    // 签发直接 resolve，prevalidate 的 authority 校验同样拒绝。
    const resolved = resolveCommitted(next, "ua_conflict");
    expect(resolved.status).toBe("issuance_rejected");
    // 两个权威原样保留（不任选其一）。
    expect(readTreasuryQuarantineEntry("ua_conflict")).toBeDefined();
    expect(readTreasuryIntentEntry("ua_conflict")).toBeDefined();
  });

  it("同 id 双权威 postings 不一致 fail closed", () => {
    const next = makeService();
    seedIntentOnly("ua_conflict2", "executing");
    quarantineTreasuryTransaction({
      transactionId: "ua_conflict2",
      digest: "0123456789abcdef", // digest 一致
      tick: Game.time,
      kind: "terminal.send",
      source: "test",
      phase: "executing_at_end_tick",
      outcome: "started_unknown",
      settlement: "quarantined",
      // postings 不同（delta 不同）。
      deltas: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -999 }],
      recordedAt: Game.time,
    });
    Game.time += 1;
    const issued = issueCapability(next, "ua_conflict2");
    expect(issued.status).toBe("rejected");
    if (issued.status === "rejected") expect(issued.reason).toBe("authority_inconsistent");
  });
});

describe("capability 私有化与 generation 校验（第九轮 4.8）", () => {
  function seedIntentOnly(transactionId: string, legacyPhase: string): void {
    const mapped = migrateTreasuryLegacyIntentPhase(legacyPhase);
    if (mapped === null) throw new Error(`seedIntentOnly: 未知 legacy phase ${legacyPhase}`);
    const write = writeTreasuryIntentEntry({
      transactionId,
      digest: "0123456789abcdef",
      actionKind: "terminal.send",
      kind: "terminal.send",
      adapterSemanticIdentity: "terminal.send@reconciler-semantics-v1",
      source: "test",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -500 }],
      outcome: mapped.outcome,
      settlement: mapped.settlement,
      createdAtTick: Game.time,
      updatedAtTick: Game.time,
    });
    expect(write.status).toBe("written");
  }

  it("签发的 capability 携带 authorityKind 与完整绑定字段（intent-only 场景）", () => {
    const service = makeService();
    seedIntentOnly("cap_fields", "executing");
    Game.time += 1;
    const next = makeService();
    next.beginTick();
    const issued = issueCapability(next, "cap_fields");
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    // 恢复已转 quarantine（intent 释放）——capability 的 authorityKind 反映
    // 签发时点的 authority 形态。
    expect(["quarantine", "intent"]).toContain(issued.capability.authorityKind);
    expect(issued.capability.reconcilerKind).toBe("terminal.send");
    expect(issued.capability.reconcilerVersion).toBeGreaterThan(0);
  });

  it("resolution 内核不再接受调用者提交的 serviceGeneration（签名封闭）", () => {
    const service = makeService();
    makeExecutingQuarantine("cap_nogen");
    const next = advanceTick();
    const issued = issueCapability(next, "cap_nogen");
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    // 新签名：service 为第一参数；输入对象无 serviceGeneration 字段——
    // capability 校验由 service 闭包执行（generation 取闭包值）。伪造的
    // "自报 generation" 输入路径不存在（TS 类型层面已封闭）。
    const resolved = next.resolveUnresolvedTransaction({
      transactionId: "cap_nogen",
      capability: issued.capability,
    });
    expect(resolved.status).toBe("resolved");
    void service;
  });
});

  it("【第九轮 4.10】resolving tombstone 永不被 retention 清理（超龄保留；满载 fail closed）", () => {
    // 构造：255 条超龄 final（可清理）+ 1 条超龄 resolving → 满载 256。
    Game.time += 7_000;
    const ancient = Game.time - 6_000;
    for (let i = 0; i < 255; i += 1) {
      expect(
        writeTreasuryResolutionTombstone({
          transactionId: `rt_final_${String(i)}`,
          digest: "0123456789abcdef",
          resolution: "not-executed",
          stage: "final",
          proofLevel: "legacy",
          actionTick: ancient,
          observationTick: ancient,
          resolvedAtTick: ancient,
        }).status,
      ).not.toBe("rejected");
    }
    expect(
      writeTreasuryResolutionTombstone({
        transactionId: "rt_resolving_stale",
        digest: "0123456789abcdef",
        resolution: "committed",
        stage: "resolving",
        proofLevel: "legacy",
        settledAtTick: ancient,
        actionTick: ancient,
        observationTick: ancient,
        resolvedAtTick: ancient,
      }).status,
    ).not.toBe("rejected");
    expect(peekTreasuryResolutionStoreHealth().entryCount).toBe(256);
    // 写第 257 条触发满载惰性清理：超龄 final 被清、超龄 resolving 保留。
    const write = writeTreasuryResolutionTombstone({
      transactionId: "rt_new",
      digest: "0123456789abcdef",
      resolution: "not-executed",
      stage: "final",
      proofLevel: "legacy",
      actionTick: Game.time,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
    });
    expect(write.status).not.toBe("rejected");
    expect(readTreasuryResolutionTombstone("rt_resolving_stale")).toBeDefined(); // resolving 保留
    expect(readTreasuryResolutionTombstone("rt_final_0")).toBeUndefined(); // 超龄 final 被清
  });

  it("【第九轮 4.10】满载且全部为 resolving：新 resolution fail closed（不驱逐）", () => {
    Game.time += 7_000;
    const ancient = Game.time - 6_000;
    for (let i = 0; i < 256; i += 1) {
      expect(
        writeTreasuryResolutionTombstone({
          transactionId: `rt_res_${String(i)}`,
          digest: "0123456789abcdef",
          resolution: "committed",
          stage: "resolving",
          proofLevel: "legacy",
          settledAtTick: ancient,
          actionTick: ancient,
          observationTick: ancient,
          resolvedAtTick: ancient,
        }).status,
      ).not.toBe("rejected");
    }
    expect(peekTreasuryResolutionStoreHealth().entryCount).toBe(256);
    const rejected = writeTreasuryResolutionTombstone({
      transactionId: "rt_res_overflow",
      digest: "0123456789abcdef",
      resolution: "not-executed",
      stage: "final",
      proofLevel: "legacy",
      actionTick: Game.time,
      observationTick: Game.time,
      resolvedAtTick: Game.time,
    });
    expect(rejected.status).toBe("rejected"); // fail closed：无可清理 final 项
    expect(readTreasuryResolutionTombstone("rt_res_255")).toBeDefined();
  });

  it("【第九轮 4.10】final not-executed 恢复补释放 intent（intent-only authority 场景）", () => {
    const intentWrite = writeTreasuryIntentEntry({
      transactionId: "rt_intent_release",
      digest: "0123456789abcdef",
      actionKind: "terminal.send",
      kind: "terminal.send",
      adapterSemanticIdentity: "terminal.send@reconciler-semantics-v1",
      source: "test",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -500 }],
      outcome: "returned_non_ok",
      settlement: "pending_abort",
      createdAtTick: Game.time,
      updatedAtTick: Game.time,
    });
    expect(intentWrite.status).toBe("written");
    expect(
      writeTreasuryResolutionTombstone({
        transactionId: "rt_intent_release",
        digest: "0123456789abcdef",
        resolution: "not-executed",
        stage: "final",
        proofLevel: "legacy",
        actionTick: Game.time,
        observationTick: Game.time,
        resolvedAtTick: Game.time,
        reconcilerKind: "terminal.send",
      }).status,
    ).not.toBe("rejected");
    Game.time += 1;
    const next = makeService();
    next.beginTick(); // 恢复：final not-executed + intent 残留 → 补完成释放
    expect(readTreasuryIntentEntry("rt_intent_release")).toBeUndefined();
  });

describe("service-private resolution（第十轮 3.12.8：闭包 kernel + capability 消费时点）", () => {
  it("结构兼容的伪 service 无法调用 resolution kernel", () => {
    makeExecutingQuarantine("r10_fake");
    const next = advanceTick();
    const issued = issueCapability(next, "r10_fake");
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    const fakeAuthority = {
      validateReconciliationCapability: next.consumeReconciliationCapability.bind(next),
      consumeReconciliationCapability: next.consumeReconciliationCapability.bind(next),
    };
    const rejected = resolveTreasuryQuarantinedTransactionAsCommitted(fakeAuthority, {
      transactionId: "r10_fake",
      digest: readTreasuryQuarantineEntry("r10_fake")!.digest,
      capability: issued.capability,
    });
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") {
      expect(rejected.reason).toBe("invalid_input");
      expect(rejected.detail).toContain("不持有 resolution kernel");
    }
    // 隔离不动。
    expect(readTreasuryQuarantineEntry("r10_fake")).toBeDefined();
  });

  it("capability 在前置检查失败时不被消费（staged 写入前拒绝可重试）", () => {
    // 构造 store fatal：issue 后破坏 intent store → resolve 拒绝 → capability 未烧。
    const { digest } = makeExecutingQuarantine("r10_kept");
    const next = advanceTick();
    const issued = issueCapability(next, "r10_kept");
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;
    (Memory.runtime!.treasury!.intents as { version: number }).version = 99;
    resetTreasuryIntentRuntimeForTest();
    const rejected = next.resolveUnresolvedTransaction({ transactionId: "r10_kept", digest, capability: issued.capability });
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("intent_store_fatal");
    // capability 未被消费（validate 只读）——修复 store 后同 capability 可重试成功。
    (Memory.runtime!.treasury!.intents as { version: number }).version = 3;
    resetTreasuryIntentRuntimeForTest();
    const retried = next.resolveUnresolvedTransaction({ transactionId: "r10_kept", digest, capability: issued.capability });
    expect(retried.status).toBe("resolved");
  });
});

describe("resolution 内部封闭（第十一轮 3.13.8）", () => {
  it("公共 service 类型与运行时枚举不存在 consume/generation/guard；普通对象无法提前消费 capability", () => {
    // 未包装的生产 service（testHarness 视图有意展开测试原语——生产面
    // 以 createTreasuryService 直接产物验证）。
    const rooms = installRooms(ROOMS);
    const production = createTreasuryService({ getRooms: () => Object.values(rooms) });
    // 运行时枚举：公共方法面不存在内部原语。
    const publicService = production as unknown as Record<string, unknown>;
    expect("consumeReconciliationCapability" in publicService).toBe(false);
    expect("treasuryServiceGeneration" in publicService).toBe(false);
    expect("treasuryResolutionGuard" in publicService).toBe(false);
    // kernel symbol 为 non-enumerable（Object.keys 不可见）。
    expect(Object.getOwnPropertySymbols(production).length).toBeGreaterThan(0);
    expect(Object.keys(production).includes("TREASURY_RESOLUTION_KERNEL")).toBe(false);
    // 普通对象（无 symbol kernel）无法消费 capability——resolution kernel 不可达。
    const plain = { consumeReconciliationCapability: () => ({ status: "valid" }) };
    expect(() =>
      resolveTreasuryQuarantinedTransactionAsNotExecuted(plain as never, {
        transactionId: "privacy_plain",
        capability: {} as never,
      }),
    ).not.toThrow();
    const rejected = resolveTreasuryQuarantinedTransactionAsNotExecuted(plain as never, {
      transactionId: "privacy_plain",
      capability: {} as never,
    });
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") {
      expect(rejected.detail).toContain("不持有 resolution kernel");
    }
  });
});
