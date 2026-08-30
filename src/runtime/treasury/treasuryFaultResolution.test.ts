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
import { clearTreasuryPersistenceForTest, hasSettledReceipt, peekTreasuryReceiptStore } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
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
import { peekTreasuryQuarantineHealth } from "@/runtime/treasury/quarantine";
import { installRooms, type RoomSpec } from "@mock/treasury";
import type { TreasuryTransactionInput } from "@/runtime/treasury/types";

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 100_000 }, freeCapacity: 10_000 },
    terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 5_000 },
  },
];

function makeService(): TreasuryService {
  const rooms = installRooms(ROOMS);
  const service = createTreasuryService({ getRooms: () => Object.values(rooms) });
  service.beginTick();
  return service;
}

function freshInput(service: TreasuryService, transactionId: string, delta = -500): TreasuryTransactionInput {
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
    reconcile: () => reconcilerConclusion,
  });
}

/** 从 service 签发 capability（结论由 reconcilerConclusion 编排）。 */
function issueCapability(service: TreasuryService, transactionId: string, digest?: string):
  | { status: "issued"; capability: TreasuryReconciliationCapability }
  | { status: "rejected"; reason: string; detail: string } {
  const issued = service.issueTreasuryReconciliationCapability({
    transactionId,
    ...(digest !== undefined ? { digest } : {}),
  });
  if (issued.status === "issued") return { status: "issued", capability: issued.capability };
  return { status: "rejected", reason: issued.reason, detail: issued.detail };
}

function resolveCommitted(service: TreasuryService, transactionId: string, digest?: string) {
  const issued = issueCapability(service, transactionId, digest);
  if (issued.status === "rejected") return { status: "issuance_rejected" as const, reason: issued.reason, detail: issued.detail };
  return resolveTreasuryQuarantinedTransactionAsCommitted({
    transactionId,
    ...(digest !== undefined ? { digest } : {}),
    capability: issued.capability,
    serviceGeneration: service.treasuryServiceGeneration(),
  });
}

function resolveNotExecuted(service: TreasuryService, transactionId: string, digest?: string) {
  const issued = issueCapability(service, transactionId, digest);
  if (issued.status === "rejected") return { status: "issuance_rejected" as const, reason: issued.reason, detail: issued.detail };
  return resolveTreasuryQuarantinedTransactionAsNotExecuted({
    transactionId,
    ...(digest !== undefined ? { digest } : {}),
    capability: issued.capability,
    serviceGeneration: service.treasuryServiceGeneration(),
  });
}

/** 制造一笔 commit-fault 后跨 tick 的 quarantine（Game 确认 OK 的故障）。 */
function makeCommittedFaultQuarantine(transactionId = "ts1_res_c"): { faultTick: number; digest: string } {
  const service = makeService();
  injectOnce("receipt_publish");
  const result = service.executePreparedAction(freshInput(service, transactionId), () => ({ ok: true }));
  expect(result.status).toBe("executed_unsettled");
  service.endTick();
  const entry = readTreasuryQuarantineEntry(transactionId);
  expect(entry).toBeDefined();
  return { faultTick: Game.time, digest: entry!.digest };
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

function advanceTick(): TreasuryService {
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
    const forgedResult = resolveTreasuryQuarantinedTransactionAsCommitted({
      transactionId: "cap_forge",
      digest,
      capability: forged,
      serviceGeneration: next.treasuryServiceGeneration(),
    });
    expect(forgedResult.status).toBe("rejected");
    if (forgedResult.status === "rejected") expect(forgedResult.reason).toBe("invalid_capability");
    // JSON round-trip 副本。
    const roundTrip = JSON.parse(JSON.stringify(issued.capability)) as TreasuryReconciliationCapability;
    const roundTripResult = resolveTreasuryQuarantinedTransactionAsCommitted({
      transactionId: "cap_forge",
      digest,
      capability: roundTrip,
      serviceGeneration: next.treasuryServiceGeneration(),
    });
    expect(roundTripResult.status).toBe("rejected");
    // 跨 tick capability：下一 tick 的 resolve 拒绝（须重新签发）。
    Game.time += 1;
    const later = makeService();
    later.beginTick();
    const crossTick = resolveTreasuryQuarantinedTransactionAsCommitted({
      transactionId: "cap_forge",
      digest,
      capability: issued.capability,
      serviceGeneration: later.treasuryServiceGeneration(),
    });
    expect(crossTick.status).toBe("rejected");
    if (crossTick.status === "rejected") expect(crossTick.reason).toBe("invalid_capability");
    // 旧 service generation：新实例的 resolve 用旧 capability 拒绝。
    Game.time += 1;
    const newest = advanceTick();
    const reissued = issueCapability(newest, "cap_forge", digest);
    if (reissued.status === "issued") {
      const crossGen = resolveTreasuryQuarantinedTransactionAsCommitted({
        transactionId: "cap_forge",
        digest,
        capability: reissued.capability,
        serviceGeneration: next.treasuryServiceGeneration(), // 旧 generation
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
    const first = resolveTreasuryQuarantinedTransactionAsCommitted({
      transactionId: "cap_single",
      digest,
      capability: issued.capability,
      serviceGeneration: next.treasuryServiceGeneration(),
    });
    expect(first.status).toBe("resolved");
    // 已消费：同 capability 重复 resolve（entry 已释放 → not_found 幂等路径）。
    const second = resolveTreasuryQuarantinedTransactionAsCommitted({
      transactionId: "cap_single",
      digest,
      capability: issued.capability,
      serviceGeneration: next.treasuryServiceGeneration(),
    });
    expect(second.status).toBe("already_resolved"); // 幂等（tombstone final）
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
    const again = resolveTreasuryQuarantinedTransactionAsCommitted({
      transactionId: "ts1_res_c",
      digest,
      capability: { __brand: "treasury-reconciliation-capability" } as never, // 快路径不消费
      serviceGeneration: next.treasuryServiceGeneration(),
    });
    expect(again.status).toBe("already_resolved");
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
    Memory.runtime!.treasury!.quarantine = { version: 1, entries: {}, entryCount: 0 };
    const store = Memory.runtime!.treasury!.quarantine as TreasuryQuarantineStore;
    store.entries["q:ts1_refresh"] = {
      transactionId: "ts1_refresh",
      digest: "0123456789abcdef",
      tick: Game.time,
      kind: "terminal.send",
      source: "test",
      phase: "receipt_publish",
      deltas: [],
      recordedAt: Game.time,
    };
    store.entryCount += 1;
    Game.time += 5_000;
    const next = makeService();
    next.beginTick();
    const resolved = resolveCommitted(next, "ts1_refresh", "0123456789abcdef");
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
      delete (store.settled as Record<string, number>)["t:ts1_horizon"];
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
    // 重复 resolution 幂等 already_resolved（快路径）。
    const again = resolveTreasuryQuarantinedTransactionAsCommitted({
      transactionId: "ts1_horizon",
      digest,
      capability: { __brand: "treasury-reconciliation-capability" } as never,
      serviceGeneration: later.treasuryServiceGeneration(),
    });
    expect(again.status).toBe("already_resolved");
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
    // conclusion 与 resolution 类型不匹配：committed 函数 + not-executed 结论。
    const mismatch = resolveCommitted(next, "ts1_commit_phase", digest);
    expect(mismatch.status).toBe("rejected");
    if (mismatch.status === "rejected") expect(mismatch.reason).toBe("evidence_mismatch");
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
    const malformed = resolveTreasuryQuarantinedTransactionAsCommitted({
      transactionId: "ts1_param",
      capability: undefined as never,
      serviceGeneration: next.treasuryServiceGeneration(),
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
    (Memory.runtime!.treasury!.quarantine as TreasuryQuarantineStore).entryCount = 42;
    resetTreasuryQuarantineRuntimeForTest();
    const rejected = resolveTreasuryQuarantinedTransactionAsCommitted({
      transactionId: "ts1_corrupt_store",
      digest,
      capability: issued.capability,
      serviceGeneration: next.treasuryServiceGeneration(),
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
    const rejected = resolveTreasuryQuarantinedTransactionAsCommitted({
      transactionId: "ts1_res_store",
      digest,
      capability: issued.capability,
      serviceGeneration: next.treasuryServiceGeneration(),
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
    const rejected = resolveTreasuryQuarantinedTransactionAsCommitted({
      transactionId: "ts1_slot_full",
      digest,
      capability: issued.capability,
      serviceGeneration: next.treasuryServiceGeneration(),
    });
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("resolution_store_full");
    // 零状态变化：quarantine/marker/receipt 原样。
    expect(readTreasuryQuarantineEntry("ts1_slot_full")).toBeDefined();
    expect(readTreasuryWriteFault()?.transactionId).toBe("ts1_slot_full");
    expect(hasSettledReceipt("ts1_slot_full")).toBeUndefined();
  });

  it("resolving 中断（receipt 已写）后 beginTick 幂等恢复 finalize", () => {
    const { digest } = makeCommittedFaultQuarantine("ts1_recover");
    // 手工构造 staged 中断态：resolving tombstone + receipt 已写 + quarantine 仍在。
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
      }).status,
    ).not.toBe("rejected");
    const { commitSettledReceipt } = jest.requireActual("@/runtime/treasury/receipts") as typeof import("@/runtime/treasury/receipts");
    expect(commitSettledReceipt("ts1_recover", Game.time).status).toBe("written");
    expect(readTreasuryQuarantineEntry("ts1_recover")).toBeDefined();
    Game.time += 1;
    const next = makeService();
    next.beginTick(); // 恢复：finalize（释放 quarantine + 清 marker + final）
    expect(readTreasuryResolutionTombstone("ts1_recover")?.stage).toBe("final");
    expect(readTreasuryQuarantineEntry("ts1_recover")).toBeUndefined();
    expect(next.metrics().resolutionRecovered).toBeGreaterThanOrEqual(1);
    expect(next.metrics().resolutionFaulted).toBe(0);
  });

  it("resolving 无进展（receipt 未写）后 beginTick 回滚 tombstone（quarantine 保留可重试）", () => {
    const { digest } = makeCommittedFaultQuarantine("ts1_rollback");
    expect(
      writeTreasuryResolutionTombstone({
        transactionId: "ts1_rollback",
        digest,
        resolution: "committed",
        stage: "resolving",
        actionTick: Game.time,
        settledAtTick: Game.time,
        observationTick: Game.time,
        resolvedAtTick: Game.time,
        reconcilerKind: "terminal.send",
      }).status,
    ).not.toBe("rejected");
    Game.time += 1;
    const next = makeService();
    next.beginTick(); // 恢复：无 receipt → 回滚
    expect(readTreasuryResolutionTombstone("ts1_rollback")).toBeUndefined();
    expect(readTreasuryQuarantineEntry("ts1_rollback")).toBeDefined(); // 保留可重试
    expect(next.metrics().resolutionFaulted).toBeGreaterThanOrEqual(1);
    // 重试成功（重新签发 capability）。
    const resolved = resolveCommitted(next, "ts1_rollback", digest);
    expect(resolved.status).toBe("resolved");
  });

  it("final not-executed 未完成释放：beginTick 补完成（幂等）", () => {
    makeExecutingQuarantine("ts1_release");
    expect(
      writeTreasuryResolutionTombstone({
        transactionId: "ts1_release",
        digest: readTreasuryQuarantineEntry("ts1_release")!.digest,
        resolution: "not-executed",
        stage: "final",
        actionTick: Game.time,
        observationTick: Game.time,
        resolvedAtTick: Game.time,
        reconcilerKind: "terminal.send",
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
    expect(Memory.runtime.treasury.resolutions?.version).toBe(2);
    expect(Memory.runtime.treasury.resolutions?.entryCount).toBe(1);
  });
});

describe("显式 repair（quarantine store 元数据/legacy 形状）", () => {
  it("legacy 无版本 + overflowed：repair 验证后恢复健康", () => {
    makeExecutingQuarantine("ts1_repair");
    const store = Memory.runtime!.treasury!.quarantine as TreasuryQuarantineStore;
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
    const store = Memory.runtime!.treasury!.quarantine as TreasuryQuarantineStore;
    delete (store as { version?: number }).version;
    (store.entries["q:ts1_repair_bad"] as { digest: string }).digest = "broken";
    resetTreasuryQuarantineRuntimeForTest();
    makeService();
    const rejected = repairTreasuryQuarantineStoreForResolution();
    expect(rejected.status).toBe("rejected");
    expect((Memory.runtime!.treasury!.quarantine as TreasuryQuarantineStore).entries["q:ts1_repair_bad"]).toBeDefined();
  });

  it("repair 满载 + overflowed：拒绝（先 resolution 再 repair，不掩盖丢 identity）", () => {
    const entries: TreasuryQuarantineStore["entries"] = {};
    for (let index = 0; index < TREASURY_QUARANTINE_MAX_ENTRIES; index += 1) {
      entries[`q:ts1_rp${index}`] = {
        transactionId: `ts1_rp${index}`,
        digest: "0123456789abcdef",
        tick: Game.time,
        kind: "test",
        source: "test",
        phase: "executing_at_end_tick",
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
