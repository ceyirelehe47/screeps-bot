/**
 * Treasury 显式 fault resolution 协议测试（第六轮建立、第七轮重做为
 * post-observation 证据协议）：
 * - resolve-as-committed：以 **resolution tick** 写 receipt（完整 retention
 *   窗口——延迟 5001+ tick 后 resolution 的 receipt 下一 tick cleanup 不删）、
 *   原 action tick 保留在 tombstone、释放 quarantine、清除匹配 marker、
 *   防重放、重复调用幂等（receipt 与 tombstone 双通道 already_resolved）；
 * - resolve-as-not-executed：仅 execution-unknown 类 phase 配合
 *   observed_not_executed 证据允许；释放 quarantine、不写 receipt、允许重新
 *   prepare；commit 类 phase 一律拒绝；
 * - still_uncertain：保持隔离零副作用；
 * - resolution 前置检查（第七轮）：active handle 存在拒绝（endTick 后放行，
 *   且 resolution 后 endTick 不重新 quarantine）、当前 tick 不晚于故障 tick
 *   拒绝、无故障后 shared observation 拒绝、evidence 观察 stale/未来拒绝、
 *   conclusion 与 resolution 类型不匹配拒绝；
 * - 参数校验：未知 transactionId、digest 不匹配、malformed input → 拒绝且
 *   fault/quarantine 不动；quarantine store 损坏时 resolution 拒绝；
 * - 显式 repair：legacy overflowed/无版本 store 修复（entry 损坏拒绝）。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest, hasSettledReceipt, peekTreasuryReceiptStore } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import {
  readTreasuryWriteFault,
  setTreasuryCommitFaultInjectorForTest,
  type TreasuryWriteFaultPhase,
} from "@/runtime/treasury/writeFault";
import {
  peekTreasuryQuarantineHealth,
  readTreasuryQuarantineEntry,
  resetTreasuryQuarantineRuntimeForTest,
  treasuryQuarantineBlockers,
  TREASURY_QUARANTINE_MAX_ENTRIES,
  type TreasuryQuarantineStore,
} from "@/runtime/treasury/quarantine";
import {
  repairTreasuryQuarantineStoreForResolution,
  resolveTreasuryQuarantinedTransactionAsCommitted,
  resolveTreasuryQuarantinedTransactionAsNotExecuted,
  type TreasuryResolutionConclusion,
  type TreasuryResolutionGuard,
} from "@/runtime/treasury/faultResolution";
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

/** 推进一个 tick 并重建 service（模拟下一 tick / global reset 后新实例）。 */
function advanceTick(): TreasuryService {
  Game.time += 1;
  const service = makeService();
  return service;
}

function evidence(conclusion: TreasuryResolutionConclusion, observationTick = Game.time): { conclusion: TreasuryResolutionConclusion; observationTick: number; source: string } {
  return { conclusion, observationTick, source: "manual-inspection" };
}

/** 制造一笔 commit-fault 的立即隔离（Game 确认 OK 的故障，同 tick 内 faulted）。 */
function makeCommittedFaultQuarantine(transactionId = "ts7_res_c"): { faultTick: number; digest: string } {
  const service = makeService();
  injectOnce("receipt_publish");
  const result = service.executePreparedAction(freshInput(service, transactionId), () => ({ ok: true }));
  expect(result.status).toBe("executed_unsettled");
  const entry = readTreasuryQuarantineEntry(transactionId);
  expect(entry).toBeDefined();
  return { faultTick: Game.time, digest: entry!.digest };
}

/** 制造一笔 executing 边界隔离（Game 结果未知，endTick 时 quarantine）。 */
function makeExecutingQuarantine(transactionId = "ts7_res_e"): { faultTick: number; digest: string } {
  const service = makeService();
  service.executePreparedAction(freshInput(service, transactionId), () => {
    service.endTick();
    return { ok: false as const };
  });
  const entry = readTreasuryQuarantineEntry(transactionId);
  expect(entry).toBeDefined();
  return { faultTick: Game.time, digest: entry!.digest };
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  setTreasuryCommitFaultInjectorForTest(null);
});

afterEach(() => {
  setTreasuryCommitFaultInjectorForTest(null);
});

describe("resolve-as-committed（resolution tick 时间协议）", () => {
  it("receipt 使用 resolution tick：actionTick 保留于 tombstone、释放 quarantine、清 marker、防重放、幂等", () => {
    const { faultTick, digest } = makeCommittedFaultQuarantine();
    const next = advanceTick();
    const guard = next.treasuryResolutionGuard();
    const resolved = resolveTreasuryQuarantinedTransactionAsCommitted({
      transactionId: "ts7_res_c",
      digest,
      evidence: evidence("observed_committed"),
      guard,
    });
    expect(resolved.status).toBe("resolved");
    if (resolved.status === "resolved") {
      expect(resolved.resolution).toBe("committed");
      expect(resolved.receiptWritten).toBe(true); // receipt_publish 故障：receipt 未写，本次补全
      expect(resolved.reprepareAllowed).toBe(false);
      expect(resolved.actionTick).toBe(faultTick); // 原 action tick 审计保留
      expect(resolved.settledAtTick).toBe(Game.time); // retention 起点 = resolution tick
    }
    // receipt 结算 tick = resolution tick（不是旧 action tick）。
    expect(hasSettledReceipt("ts7_res_c")).toBe(Game.time);
    expect(readTreasuryQuarantineEntry("ts7_res_c")).toBeUndefined();
    expect(readTreasuryWriteFault()).toBeUndefined();
    // 防重放：同 id 重新 prepare 命中 already_settled。
    const replay = next.prepareTransaction(freshInput(next, "ts7_res_c"));
    expect(replay.status).toBe("already_settled");
    // 幂等：重复调用 already_resolved（receipt 仍在 retention 内）。
    const again = resolveTreasuryQuarantinedTransactionAsCommitted({
      transactionId: "ts7_res_c",
      digest,
      evidence: evidence("observed_committed"),
      guard: next.treasuryResolutionGuard(),
    });
    expect(again.status).toBe("already_resolved");
  });

  it("延迟 5001 tick 后 resolve-as-committed：receipt 仍存活完整 retention 窗口（下一 tick cleanup 不删）", () => {
    const { digest } = makeCommittedFaultQuarantine("ts7_res_late");
    Game.time += 5_001; // 远超 receipt retention
    const next = makeService();
    next.beginTick(); // 故障后 observation 已建立（currentObservationTick = 当前）
    const resolved = resolveTreasuryQuarantinedTransactionAsCommitted({
      transactionId: "ts7_res_late",
      digest,
      evidence: evidence("observed_committed"),
      guard: next.treasuryResolutionGuard(),
    });
    expect(resolved.status).toBe("resolved");
    expect(hasSettledReceipt("ts7_res_late")).toBe(Game.time); // resolution tick
    // 下一 tick cleanup：nextExpiryTick = resolution+5001 尚未到 → 零删除。
    Game.time += 1;
    const after = makeService();
    after.beginTick();
    expect(hasSettledReceipt("ts7_res_late")).toBe(Game.time - 1);
    const store = peekTreasuryReceiptStore();
    expect(store?.nextExpiryTick).toBe((Game.time - 1) + 5_000 + 1);
  });

  it("receipt retention 过期后重复 resolution：tombstone 仍回答 already_resolved（不模糊 not_found）", () => {
    const { digest } = makeCommittedFaultQuarantine("ts7_res_tomb");
    const next = advanceTick();
    expect(
      resolveTreasuryQuarantinedTransactionAsCommitted({
        transactionId: "ts7_res_tomb",
        digest,
        evidence: evidence("observed_committed"),
        guard: next.treasuryResolutionGuard(),
      }).status,
    ).toBe("resolved");
    // 模拟 receipt retention 过期被清理（tombstone 保留）。
    Game.time += 5_100;
    const later = makeService();
    later.beginTick();
    const store = peekTreasuryReceiptStore();
    if (store) {
      delete (store.settled as Record<string, number>)["t:ts7_res_tomb"];
      store.entryCount -= 1;
    }
    expect(hasSettledReceipt("ts7_res_tomb")).toBeUndefined();
    const again = resolveTreasuryQuarantinedTransactionAsCommitted({
      transactionId: "ts7_res_tomb",
      digest,
      evidence: evidence("observed_committed"),
      guard: later.treasuryResolutionGuard(),
    });
    expect(again.status).toBe("already_resolved"); // tombstone 幂等通道
  });

  it("global reset 后（service 重建）仍可完成 resolution", () => {
    const { digest } = makeCommittedFaultQuarantine("ts7_res_reset");
    // 模拟 global reset：heap 全失，Memory 保留（advanceTick 即新实例）。
    const next = advanceTick();
    const resolved = resolveTreasuryQuarantinedTransactionAsCommitted({
      transactionId: "ts7_res_reset",
      digest,
      evidence: evidence("observed_committed"),
      guard: next.treasuryResolutionGuard(),
    });
    expect(resolved.status).toBe("resolved");
  });
});

describe("resolve-as-not-executed（证据与 phase 语义）", () => {
  it("execution-unknown phase + observed_not_executed 证据：释放且可重新 prepare（不写 receipt）", () => {
    makeExecutingQuarantine("ts7_ne");
    const next = advanceTick();
    const resolved = resolveTreasuryQuarantinedTransactionAsNotExecuted({
      transactionId: "ts7_ne",
      evidence: evidence("observed_not_executed"),
      guard: next.treasuryResolutionGuard(),
    });
    expect(resolved.status).toBe("resolved");
    if (resolved.status === "resolved") {
      expect(resolved.resolution).toBe("not-executed");
      expect(resolved.receiptWritten).toBe(false);
      expect(resolved.reprepareAllowed).toBe(true);
    }
    expect(hasSettledReceipt("ts7_ne")).toBeUndefined();
    expect(readTreasuryQuarantineEntry("ts7_ne")).toBeUndefined();
    // 重新 prepare 成功（同 id 合法复用）。
    const reprepared = next.prepareTransaction(freshInput(next, "ts7_ne"));
    expect(reprepared.status).toBe("prepared");
  });

  it("callback 抛错（action_threw_execution_unknown）：无证据不得 not-executed；有 observed_not_executed 证据可释放", () => {
    const service = makeService();
    try {
      service.executePreparedAction(freshInput(service, "ts7_threw"), () => {
        throw new Error("boom");
      });
    } catch {
      /* 预期 rethrow */
    }
    expect(readTreasuryQuarantineEntry("ts7_threw")?.phase).toBe("action_threw_execution_unknown");
    const next = advanceTick();
    // still_uncertain 不是"未执行"证据：保持隔离。
    const uncertain = resolveTreasuryQuarantinedTransactionAsNotExecuted({
      transactionId: "ts7_threw",
      evidence: evidence("still_uncertain"),
      guard: next.treasuryResolutionGuard(),
    });
    expect(uncertain.status).toBe("uncertain");
    expect(readTreasuryQuarantineEntry("ts7_threw")).toBeDefined();
    // 显式 observed_not_executed 证据（对账确认副作用未发生）才可释放。
    const resolved = resolveTreasuryQuarantinedTransactionAsNotExecuted({
      transactionId: "ts7_threw",
      evidence: evidence("observed_not_executed"),
      guard: next.treasuryResolutionGuard(),
    });
    expect(resolved.status).toBe("resolved");
    expect(readTreasuryQuarantineEntry("ts7_threw")).toBeUndefined();
  });

  it("commit 类 phase（Game 已 OK）不允许 not-executed；evidence 结论不匹配同样拒绝", () => {
    const { digest } = makeCommittedFaultQuarantine("ts7_commit_phase");
    const next = advanceTick();
    const rejected = resolveTreasuryQuarantinedTransactionAsNotExecuted({
      transactionId: "ts7_commit_phase",
      digest,
      evidence: evidence("observed_not_executed"),
      guard: next.treasuryResolutionGuard(),
    });
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("resolution_not_allowed");
    // conclusion 与 resolution 类型不匹配：committed 函数 + not-executed 证据。
    const mismatch = resolveTreasuryQuarantinedTransactionAsCommitted({
      transactionId: "ts7_commit_phase",
      digest,
      evidence: evidence("observed_not_executed"),
      guard: next.treasuryResolutionGuard(),
    });
    expect(mismatch.status).toBe("rejected");
    if (mismatch.status === "rejected") expect(mismatch.reason).toBe("evidence_mismatch");
    // fault 保持不动。
    expect(readTreasuryQuarantineEntry("ts7_commit_phase")).toBeDefined();
    expect(readTreasuryWriteFault()?.transactionId).toBe("ts7_commit_phase");
  });
});

describe("resolution 与 service 状态协调（第七轮前置检查）", () => {
  it("active handle 仍存在时拒绝（同 tick faulted handle）；endTick 后放行且不再重新 quarantine", () => {
    const service = makeService();
    injectOnce("receipt_publish");
    const result = service.executePreparedAction(freshInput(service, "ts7_active_handle"), () => ({ ok: true }));
    expect(result.status).toBe("executed_unsettled");
    // 同 tick：handle 仍 active（faulted）→ active_handle_present 拒绝。
    const rejected = resolveTreasuryQuarantinedTransactionAsCommitted({
      transactionId: "ts7_active_handle",
      evidence: evidence("observed_committed"),
      guard: service.treasuryResolutionGuard(),
    });
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("active_handle_present");
    expect(readTreasuryQuarantineEntry("ts7_active_handle")).toBeDefined(); // fault 不动
    // 下一 tick（handle 已被 tick 边界终态化）：resolution 放行。
    const next = advanceTick();
    const resolved = resolveTreasuryQuarantinedTransactionAsCommitted({
      transactionId: "ts7_active_handle",
      evidence: evidence("observed_committed"),
      guard: next.treasuryResolutionGuard(),
    });
    expect(resolved.status).toBe("resolved");
    // resolution 后 endTick 不得重新 quarantine（entry 已释放、handle 不在 registry）。
    next.endTick();
    expect(readTreasuryQuarantineEntry("ts7_active_handle")).toBeUndefined();
  });

  it("当前 tick 不晚于故障 tick 时拒绝（同 tick 不得 resolution）", () => {
    makeExecutingQuarantine("ts7_same_tick");
    const service = makeService(); // 未推进 Game.time：当前 tick == 故障 tick
    const rejected = resolveTreasuryQuarantinedTransactionAsCommitted({
      transactionId: "ts7_same_tick",
      evidence: evidence("observed_committed"),
      guard: service.treasuryResolutionGuard(),
    });
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("resolution_not_allowed");
  });

  it("系统尚未建立故障后 shared observation 时拒绝（guard.currentObservationTick <= 故障 tick）", () => {
    const { digest } = makeCommittedFaultQuarantine("ts7_no_obs");
    Game.time += 1; // tick 已推进，但 guard 声明 observation 仍是故障 tick（未 beginTick 的旧 service 视图）
    const staleGuard: TreasuryResolutionGuard = { activeTransactionIds: new Set(), currentObservationTick: Game.time - 1 };
    const rejected = resolveTreasuryQuarantinedTransactionAsCommitted({
      transactionId: "ts7_no_obs",
      digest,
      evidence: evidence("observed_committed"),
      guard: staleGuard,
    });
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("resolution_not_allowed");
  });

  it("evidence 观察 stale（≤ 故障 tick）或未来（> 当前 tick）拒绝", () => {
    const { digest } = makeCommittedFaultQuarantine("ts7_evi_time");
    const next = advanceTick();
    const stale = resolveTreasuryQuarantinedTransactionAsCommitted({
      transactionId: "ts7_evi_time",
      digest,
      evidence: evidence("observed_committed", Game.time - 1),
      guard: next.treasuryResolutionGuard(),
    });
    expect(stale.status).toBe("rejected");
    if (stale.status === "rejected") expect(stale.reason).toBe("stale_observation");
    const future = resolveTreasuryQuarantinedTransactionAsCommitted({
      transactionId: "ts7_evi_time",
      digest,
      evidence: evidence("observed_committed", Game.time + 5),
      guard: next.treasuryResolutionGuard(),
    });
    expect(future.status).toBe("rejected");
    if (future.status === "rejected") expect(future.reason).toBe("invalid_input");
    expect(readTreasuryQuarantineEntry("ts7_evi_time")).toBeDefined();
  });
});

describe("参数校验与不可信 store", () => {
  it("未知 id / digest 不匹配 / malformed input 拒绝且 fault 不动", () => {
    const { digest } = makeCommittedFaultQuarantine("ts7_param");
    const next = advanceTick();
    const guard = next.treasuryResolutionGuard();
    expect(
      resolveTreasuryQuarantinedTransactionAsCommitted({ transactionId: "ts7_missing", evidence: evidence("observed_committed"), guard }).status,
    ).toBe("rejected");
    const mismatch = resolveTreasuryQuarantinedTransactionAsCommitted({
      transactionId: "ts7_param",
      digest: "ffffffffffffffff",
      evidence: evidence("observed_committed"),
      guard,
    });
    expect(mismatch.status).toBe("rejected");
    if (mismatch.status === "rejected") expect(mismatch.reason).toBe("digest_mismatch");
    const malformed = resolveTreasuryQuarantinedTransactionAsCommitted({
      transactionId: "",
      evidence: evidence("observed_committed"),
      guard,
    });
    expect(malformed.status).toBe("rejected");
    if (malformed.status === "rejected") expect(malformed.reason).toBe("invalid_input");
    const missingGuard = resolveTreasuryQuarantinedTransactionAsCommitted({
      transactionId: "ts7_param",
      digest,
      evidence: evidence("observed_committed"),
      guard: { activeTransactionIds: [] as never, currentObservationTick: Game.time },
    });
    expect(missingGuard.status).toBe("rejected");
    expect(readTreasuryQuarantineEntry("ts7_param")).toBeDefined();
  });

  it("marker 指向其它 transaction 时保留（只清除匹配的根因）", () => {
    // 双隔离：ts7_root 首条 marker，ts7_other 的 resolution 不清 marker。
    makeExecutingQuarantine("ts7_root");
    const next = advanceTick();
    const directWrite = (() => {
      const store = Memory.runtime!.treasury!.quarantine as TreasuryQuarantineStore;
      store.entries["q:ts7_other"] = {
        transactionId: "ts7_other",
        digest: "0123456789abcdef",
        tick: Game.time - 1,
        kind: "test",
        source: "test",
        phase: "action_returned_non_ok_abort_failed",
        deltas: [],
        recordedAt: Game.time - 1,
      };
      store.entryCount += 1;
    })();
    void directWrite;
    const resolved = resolveTreasuryQuarantinedTransactionAsNotExecuted({
      transactionId: "ts7_other",
      evidence: evidence("observed_not_executed"),
      guard: next.treasuryResolutionGuard(),
    });
    expect(resolved.status).toBe("resolved");
    expect(readTreasuryWriteFault()?.transactionId).toBe("ts7_root"); // 不匹配的 marker 保留
  });

  it("quarantine store 损坏时 resolution 拒绝（不可信 store 上不得执行）", () => {
    makeCommittedFaultQuarantine("ts7_corrupt_store");
    (Memory.runtime!.treasury!.quarantine as TreasuryQuarantineStore).entryCount = 42; // 损坏元数据
    resetTreasuryQuarantineRuntimeForTest();
    const next = makeService();
    next.beginTick();
    const rejected = resolveTreasuryQuarantinedTransactionAsCommitted({
      transactionId: "ts7_corrupt_store",
      evidence: evidence("observed_committed"),
      guard: next.treasuryResolutionGuard(),
    });
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("quarantine_store_fatal");
  });
});

describe("显式 repair（quarantine store 元数据/legacy 形状）", () => {
  it("legacy 无版本 + overflowed：repair 验证后恢复健康，overflowed 不再阻断", () => {
    makeExecutingQuarantine("ts7_repair");
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
    // repair 恢复后 write admission 随 resolution 正常解锁路径恢复。
    expect(service.prepareTransaction(freshInput(service, "ts7_after_repair")).status).toBe("rejected"); // quarantine 仍在（阻断直到 resolution）
  });

  it("repair 发现损坏 entry：拒绝且原数据不动", () => {
    makeExecutingQuarantine("ts7_repair_bad");
    const store = Memory.runtime!.treasury!.quarantine as TreasuryQuarantineStore;
    delete (store as { version?: number }).version;
    (store.entries["q:ts7_repair_bad"] as { digest: string }).digest = "broken";
    resetTreasuryQuarantineRuntimeForTest();
    makeService();
    const rejected = repairTreasuryQuarantineStoreForResolution();
    expect(rejected.status).toBe("rejected");
    expect((Memory.runtime!.treasury!.quarantine as TreasuryQuarantineStore).entries["q:ts7_repair_bad"]).toBeDefined();
  });

  it("repair 不删除任何 entry（只修复元数据），满载时要求先 resolution", () => {
    // 直接构造满载合法 store（prepare 不会创建 quarantine store——只有 fault 路径写）。
    const entries: TreasuryQuarantineStore["entries"] = {};
    for (let index = 0; index < TREASURY_QUARANTINE_MAX_ENTRIES; index += 1) {
      entries[`q:ts7_rp${index}`] = {
        transactionId: `ts7_rp${index}`,
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
    expect(repairTreasuryQuarantineStoreForResolution().status).toBe("rejected"); // 满载：先 resolution
    expect(Object.keys(entries)).toHaveLength(TREASURY_QUARANTINE_MAX_ENTRIES);
  });
});
