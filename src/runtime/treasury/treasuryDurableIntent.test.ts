/**
 * Treasury durable intent / WAL 测试（第八轮）：
 * - 唯一安全顺序：Game API 前 intent(phase=ready) 落盘 → execution-started
 *   标记 → callback 恰好一次 → 非 OK 关闭+abort / OK commit → finalize 删除；
 * - intent 写入失败：callback 零调用、tentative 与槽位释放、结构化拒绝
 *   （intent_store_unavailable）；
 * - global reset 恢复：ready 确认未执行关闭（不进 quarantine/不计 receipt）；
 *   executing 及之后保守转 execution-unknown quarantine（postings 完整）；
 *   恢复幂等；
 * - quarantine 写失败：intent 保留完整 postings 与风险占用（emergency
 *   intent authority）、writer 阻断、slot 不释放、global reset 后不能重放；
 * - slot 统一计数守恒：prepare → intent 接管 → fault 转换 → 回收全程
 *   recoverySlots 不双重计数；正常 commit/abort 后回收；
 * - store 健康契约：版本化 entryCount、损坏/未知版本 fail closed（写入拒、
 *   writer 阻断、聚合空）、load 全量验证计数、entry 冻结快照封闭。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { setTreasuryCommitFaultInjectorForTest, type TreasuryWriteFaultPhase } from "@/runtime/treasury/writeFault";
import {
  quarantineTreasuryTransaction,
  readTreasuryQuarantineEntry,
  releaseTreasuryQuarantineEntry,
  resetTreasuryQuarantineRuntimeForTest,
} from "@/runtime/treasury/quarantine";
import {
  listTreasuryIntentEntries,
  progressTreasuryIntent,
  migrateTreasuryLegacyIntentPhase,
  peekTreasuryIntentHealth,
  readTreasuryIntentEntry,
  resetTreasuryIntentRuntimeForTest,
  treasuryIntentBlockers,
  treasuryIntentCapacityOccupancy,
  treasuryIntentOutflowOccupancy,
  writeTreasuryIntentEntry,
  TREASURY_INTENT_MAX_ENTRIES,
  type TreasuryIntentEntry,
} from "@/runtime/treasury/intents";
import { installRooms, type RoomSpec } from "@mock/treasury";
import type { TreasuryTransactionInput } from "@/runtime/treasury/types";
import * as intentsModule from "@/runtime/treasury/intents";
import * as quarantineModule from "@/runtime/treasury/quarantine";
import { makeTreasuryTestTransferAdapter, registerTreasuryActionAdapter } from "@/runtime/treasury/actionContracts";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
const realReadTreasuryQuarantineEntry = quarantineModule.readTreasuryQuarantineEntry;

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

/**
 * 构造一条合法 intent entry（store 直写，恢复/权威测试用）。phase 参数沿用
 * 旧（v1/v2）phase 名——经保守单调迁移表映射为 v3 (outcome, settlement)。
 */
function seedIntent(transactionId: string, legacyPhase: string, delta = -500): void {
  const mapped = migrateTreasuryLegacyIntentPhase(legacyPhase);
  if (mapped === null) throw new Error(`seedIntent: 未知 legacy phase ${legacyPhase}`);
  const write = writeTreasuryIntentEntry({
    transactionId,
    digest: "0123456789abcdef",
    actionKind: "terminal.send",
    kind: "terminal.send",
    source: "test",
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta }],
    outcome: mapped.outcome,
    settlement: mapped.settlement,
    createdAtTick: Game.time,
    updatedAtTick: Game.time,
  });
  expect(write.status).toBe("written");
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  setTreasuryCommitFaultInjectorForTest(null);
});

afterEach(() => {
  setTreasuryCommitFaultInjectorForTest(null);
});

describe("唯一安全顺序与生命周期", () => {
  it("正常 OK 路径：intent ready→executing→ok_pending_commit→随 commit 删除（WAL 完成）", () => {
    const service = makeService();
    let observedPhase = "";
    let callbackCalls = 0;
    const result = service.executePreparedAction(freshInput(service, "ti_ok"), () => {
      callbackCalls += 1;
      // callback 执行时 intent 必须已在 store（phase=executing）。
      const entry = readTreasuryIntentEntry("ti_ok");
      expect(entry).toBeDefined();
      observedPhase = entry?.settlement ?? "";
      return { ok: true as const };
    });
    expect(callbackCalls).toBe(1);
    expect(result.status).toBe("executed_committed");
    expect(observedPhase).toBe("executing"); // ready→executing 标记先于 callback
    expect(readTreasuryIntentEntry("ti_ok")).toBeUndefined(); // settled 后关闭
    expect(listTreasuryIntentEntries()).toHaveLength(0);
  });

  it("Game 非 OK：intent 随确认 abort 关闭（returned_non_ok 不残留）", () => {
    const service = makeService();
    const result = service.executePreparedAction(freshInput(service, "ti_non_ok"), () => ({ ok: false as const }));
    expect(result.status).toBe("executed_aborted");
    expect(readTreasuryIntentEntry("ti_non_ok")).toBeUndefined();
  });

  it("【第十轮 3.12.1】Game OK 后 commit fault 且 quarantine 写失败：intent-only authority 保留 returned_ok（永不降级）", () => {
    // spy 注入 quarantine 写失败（store fatal 语义）：fault 路径的 quarantine
    // 写入被拒 → intent 保留为 emergency authority——第十轮断链 2 核心场景。
    const spy = jest.spyOn(quarantineModule, "quarantineTreasuryTransaction").mockReturnValue({
      status: "rejected",
      reason: "capacity_exhausted",
      detail: "注入：quarantine 写入失败",
    });
    try {
      const service = makeService();
      injectOnce("receipt_publish");
      const result = service.executePreparedAction(freshInput(service, "ti_ok_qfail"), () => ({ ok: true as const }));
      expect(result.status).toBe("executed_unsettled");
      // quarantine 写失败 → intent 保留（emergency authority），且 outcome 保留
      // returned_ok 事实（绝不降级为 started_unknown/可能未执行）。
      const retained = readTreasuryIntentEntry("ti_ok_qfail");
      expect(retained).toBeDefined();
      expect(retained?.outcome).toBe("returned_ok");
      expect(retained?.settlement).toBe("faulted");
      expect(readTreasuryQuarantineEntry("ti_ok_qfail")).toBeUndefined();
      // 下一 tick 恢复：quarantine 仍写不进 → intent 继续保留 returned_ok。
      Game.time += 1;
      const next = makeService();
      next.beginTick();
      const stillRetained = readTreasuryIntentEntry("ti_ok_qfail");
      expect(stillRetained?.outcome).toBe("returned_ok");
      // 跨多次 recovery 事实保持单调。
      Game.time += 1;
      const third = makeService();
      third.beginTick();
      expect(readTreasuryIntentEntry("ti_ok_qfail")?.outcome).toBe("returned_ok");
    } finally {
      spy.mockRestore();
    }
  });

  it("Game OK 后 commit fault：intent 转 execution_unknown 且随 quarantine 写入成功释放（slot 守恒）", () => {
    const service = makeService();
    injectOnce("receipt_publish");
    const result = service.executePreparedAction(freshInput(service, "ti_fault"), () => ({ ok: true as const }));
    expect(result.status).toBe("executed_unsettled");
    // quarantine 已接管资产事实：intent 释放（quarantine +1、intent −1）。
    expect(readTreasuryQuarantineEntry("ti_fault")).toBeDefined();
    expect(readTreasuryIntentEntry("ti_fault")).toBeUndefined();
    const metrics = service.metrics();
    // 统一计数：1 个持久 entry、0 个 active 形态 slot（不双重计数）。
    expect(metrics.quarantineEntries).toBe(1);
    expect(metrics.durableIntents).toBe(0);
    expect(metrics.quarantineSlotsRemaining).toBe(TREASURY_INTENT_MAX_ENTRIES - 1);
  });

  it("intent 写入失败：callback 零调用、tentative 与槽位释放、结构化拒绝", () => {
    const service = makeService();
    // 轻量探测不可见的损坏（entryCount=0 但存在 ghost key）：prepare 的轻量
    // health/blocker 检查放行（entryCount=0 不阻断），intent 写入触发 load 全量
    // 验证时 fatal——唯一确定性触达 intent 写失败分支的方式。
    Memory.runtime!.treasury!.intents = {
      version: 2,
      entries: {
        "i:ghost": { transactionId: "ghost", digest: "bad", actionKind: "k", kind: "k", source: "s", postings: [], phase: "ready", createdAtTick: 1, updatedAtTick: 1 },
      },
      entryCount: 0,
      updatedAt: 1,
    } as never;
    let callbackCalls = 0;
    const result = service.executePreparedAction(freshInput(service, "ti_blocked"), () => {
      callbackCalls += 1;
      return { ok: true as const };
    });
    expect(callbackCalls).toBe(0); // Game API 零调用
    expect(result.status).toBe("prepare_rejected");
    if (result.status === "prepare_rejected") {
      expect(result.reason).toBe("intent_store_unavailable");
    }
    // 预留释放：tentative/receipt 槽回收，active handle 终态化。
    expect(service.metrics().preparedActive).toBe(0);
    expect(service.metrics().intentWriteFailures).toBe(1);
    // 损坏 store 修复前一切新 writer 阻断（fail closed）。
    const blockedAgain = service.executePreparedAction(freshInput(service, "ti_blocked2"), () => ({ ok: true as const }));
    expect(blockedAgain.status).toBe("prepare_rejected");
    if (blockedAgain.status === "prepare_rejected") expect(blockedAgain.reason).toBe("intent_store_fatal");
  });

  it("intent 写入失败后恢复路径：释放部分 intent 后新 writer 可用", () => {
    const service = makeService();
    seedIntent("ti_pending_ready", "ready");
    // 未完成 intent 阻断新 writer（恢复前）。
    const blocked = service.executePreparedAction(freshInput(service, "ti_after"), () => ({ ok: true as const }));
    expect(blocked.status).toBe("prepare_rejected");
    if (blocked.status === "prepare_rejected") expect(blocked.reason).toBe("intent_write_blocked");
    // 下一 tick beginTick 恢复：ready 确认未执行关闭。
    Game.time += 1;
    service.beginTick();
    expect(readTreasuryIntentEntry("ti_pending_ready")).toBeUndefined();
    const recovered = service.executePreparedAction(freshInput(service, "ti_after2"), () => ({ ok: true as const }));
    expect(recovered.status).toBe("executed_committed");
  });
});

describe("global reset 恢复", () => {
  it("ready 相：确认未执行关闭（不进 quarantine、不计 receipt、释放 slot）", () => {
    const service = makeService();
    seedIntent("ti_reset_ready", "ready");
    Game.time += 1;
    const next = makeService(); // 模拟 global reset（新 service 实例）
    next.beginTick();
    expect(readTreasuryIntentEntry("ti_reset_ready")).toBeUndefined();
    expect(readTreasuryQuarantineEntry("ti_reset_ready")).toBeUndefined(); // 确认未执行：不隔离
    expect(next.metrics().intentRecoveries).toBe(1);
    // 同 id 可重新执行（未执行过）。
    const retried = next.executePreparedAction(freshInput(next, "ti_reset_ready"), () => ({ ok: true as const }));
    expect(retried.status).toBe("executed_committed");
  });

  it("executing 相：保守转 execution-unknown quarantine（postings 完整保留）", () => {
    const service = makeService();
    seedIntent("ti_reset_exec", "executing", -700);
    Game.time += 1;
    const next = makeService();
    next.beginTick();
    const quarantined = readTreasuryQuarantineEntry("ti_reset_exec");
    expect(quarantined).toBeDefined();
    expect(quarantined?.deltas).toEqual([
      { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -700 },
    ]);
    expect(readTreasuryIntentEntry("ti_reset_exec")).toBeUndefined(); // 转换完成
    // 风险占用由 quarantine 接管：同 id 重新执行被拒。
    const replay = next.executePreparedAction(freshInput(next, "ti_reset_exec"), () => ({ ok: true as const }));
    expect(replay.status).toBe("prepare_rejected");
    if (replay.status === "prepare_rejected") expect(replay.reason).toBe("transaction_quarantined");
  });

  it("ok_pending_commit / execution_unknown / quarantined / resolution_pending 相恢复均转 quarantine（各按事实等级）", () => {
    const expectedPhase: Record<string, string> = {
      ok_pending_commit: "ok_pending_commit_unresolved", // 已知 Game OK——commit 类（不降级）
      execution_unknown: "executing_at_end_tick",
      quarantined: "executing_at_end_tick",
      resolution_pending: "executing_at_end_tick",
    };
    for (const phase of ["ok_pending_commit", "execution_unknown", "quarantined", "resolution_pending"] as const) {
      clearTreasuryPersistenceForTest();
      seedIntent("ti_reset_multi", phase);
      Game.time += 1;
      const next = makeService();
      next.beginTick();
      const quarantined = readTreasuryQuarantineEntry("ti_reset_multi");
      expect(quarantined).toBeDefined();
      expect(quarantined?.phase).toBe(expectedPhase[phase]);
      expect(readTreasuryIntentEntry("ti_reset_multi")).toBeUndefined();
    }
  });

  it("【第九轮 4.6】returned_non_ok 恢复保留'Game 已返回非 OK'事实（不当作 callback 仍在执行）", () => {
    seedIntent("ti_rno", "returned_non_ok");
    Game.time += 1;
    const next = makeService();
    next.beginTick();
    const quarantined = readTreasuryQuarantineEntry("ti_rno");
    expect(quarantined?.phase).toBe("action_returned_non_ok_abort_failed");
    expect(readTreasuryIntentEntry("ti_rno")).toBeUndefined();
  });

  it("【第九轮 4.6】committed/aborted 终态残留幂等释放（不进 quarantine）", () => {
    for (const phase of ["committed", "aborted"] as const) {
      clearTreasuryPersistenceForTest();
      seedIntent("ti_final_leftover", phase);
      Game.time += 1;
      const next = makeService();
      next.beginTick();
      expect(readTreasuryQuarantineEntry("ti_final_leftover")).toBeUndefined();
      expect(readTreasuryIntentEntry("ti_final_leftover")).toBeUndefined();
    }
  });

  it("恢复幂等：重复 beginTick 不重复转换/计数", () => {
    seedIntent("ti_idem", "executing");
    Game.time += 1;
    const next = makeService();
    next.beginTick();
    next.beginTick(); // 同 tick 重复（幂等）
    expect(readTreasuryQuarantineEntry("ti_idem")).toBeDefined();
    expect(next.metrics().intentQuarantineConversions).toBe(1);
  });
});

describe("emergency intent authority（quarantine 写失败）", () => {
  it("quarantine store 损坏时 intent 保留 postings/占用/slot，writer 阻断，reset 后不能重放", () => {
    const service = makeService();
    seedIntent("ti_emergency", "executing", -800);
    // 损坏 quarantine store：未知版本使一切写入/读取 fatal（先建合法 store）。
    Memory.runtime!.treasury!.quarantine = { version: 2, entries: {}, entryCount: 0 };
    (Memory.runtime!.treasury!.quarantine as { version: number }).version = 99;
    resetTreasuryIntentRuntimeForTest();
    Game.time += 1;
    const next = makeService();
    next.beginTick(); // 恢复尝试：quarantine 写失败 → intent 保留
    const retained = readTreasuryIntentEntry("ti_emergency");
    expect(retained).toBeDefined();
    expect(retained?.postings).toEqual([
      { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -800 },
    ]);
    // intent 继续参与风险占用（流出 + 容量）。
    expect(treasuryIntentOutflowOccupancy().get(`W1N57\u0000storage\u0000${RESOURCE_ENERGY}`)).toBe(800);
    // writer 全局阻断（intent blocker + quarantine store fatal）。
    const blocked = next.executePreparedAction(freshInput(next, "ti_emergency_other"), () => ({ ok: true as const }));
    expect(blocked.status).toBe("prepare_rejected");
    const view = next.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.writeAdmission.ready).toBe(false);
    expect(view.writeAdmission.blockers).toContain("intent_unresolved");
    // 同 id 不能重新执行（即使 repair 后也必须先 resolution）。
    const replay = next.executePreparedAction(freshInput(next, "ti_emergency"), () => ({ ok: true as const }));
    expect(replay.status).toBe("prepare_rejected");
  });

  it("quarantine 写失败后修复 store：下一 tick 恢复重试成功（intent→quarantine 转换完成）", () => {
    const service = makeService();
    seedIntent("ti_retry", "executing");
    Memory.runtime!.treasury!.quarantine = { version: 2, entries: {}, entryCount: 0 };
    (Memory.runtime!.treasury!.quarantine as { version: number }).version = 99;
    resetTreasuryIntentRuntimeForTest();
    Game.time += 1;
    const broken = makeService();
    broken.beginTick();
    expect(readTreasuryIntentEntry("ti_retry")).toBeDefined(); // 保留
    // 修复：重建合法空 store（同时失效 quarantine 与 intent 的 heap 缓存）。
    delete Memory.runtime!.treasury!.quarantine;
    resetTreasuryQuarantineRuntimeForTest();
    resetTreasuryIntentRuntimeForTest();
    Game.time += 1;
    const healed = makeService();
    healed.beginTick();
    expect(readTreasuryQuarantineEntry("ti_retry")).toBeDefined();
    expect(readTreasuryIntentEntry("ti_retry")).toBeUndefined();
  });
});

describe("slot 统一计数守恒", () => {
  it("prepare → intent 接管：占用恒为 1（不因 intent 落盘双重计数）", () => {
    const service = makeService();
    let slotsDuringExecute = -1;
    const result = service.executePreparedAction(freshInput(service, "ti_slot"), () => {
      // callback 期间：1 active handle + 1 intent（同 transaction）= 1 个 slot。
      slotsDuringExecute = TREASURY_INTENT_MAX_ENTRIES - service.metrics().intentSlotsRemaining;
      return { ok: true as const };
    });
    expect(result.status).toBe("executed_committed");
    expect(slotsDuringExecute).toBe(1);
    // 关闭后回收为 0。
    expect(TREASURY_INTENT_MAX_ENTRIES - service.metrics().intentSlotsRemaining).toBe(0);
  });

  it("多笔并行 active：每笔恒占一个 slot，第 65 个 prepare 在 callback 前拒绝", () => {
    const service = makeService();
    for (let index = 0; index < TREASURY_INTENT_MAX_ENTRIES; index += 1) {
      const prepared = service.prepareTransaction(freshInput(service, `ti_active${index}`));
      expect(prepared.status).toBe("prepared");
    }
    const rejected = service.prepareTransaction(freshInput(service, "ti_active_overflow"));
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("quarantine_capacity_exhausted");
    // abort 释放后恢复。
    const first = service.prepareTransaction(freshInput(service, "ti_active0")); // 幂等返回同一 handle
    expect(first.status).toBe("prepared");
    if (first.status === "prepared") {
      expect(service.abortPreparedTransaction(first.handle).status).toBe("aborted");
    }
    expect(service.prepareTransaction(freshInput(service, "ti_active_overflow")).status).toBe("prepared");
  });

  it("正常 commit/abort 后 slot 回收（无泄漏）", () => {
    const service = makeService();
    const committed = service.executePreparedAction(freshInput(service, "ti_recycle1"), () => ({ ok: true as const }));
    const aborted = service.executePreparedAction(freshInput(service, "ti_recycle2"), () => ({ ok: false as const }));
    expect(committed.status).toBe("executed_committed");
    expect(aborted.status).toBe("executed_aborted");
    expect(service.metrics().durableIntents).toBe(0);
    expect(service.metrics().intentSlotsRemaining).toBe(TREASURY_INTENT_MAX_ENTRIES);
  });
});

describe("store 健康契约", () => {
  it("版本化元数据：version/entryCount 一致，entry 冻结快照封闭", () => {
    seedIntent("ti_health", "ready");
    const health = peekTreasuryIntentHealth();
    expect(health.healthy).toBe(true);
    expect(health.entryCount).toBe(1);
    const store = Memory.runtime!.treasury!.intents!;
    expect(store.version).toBe(3);
    expect(store.entryCount).toBe(1);
    // 冻结快照：外部修改不生效。
    const snapshot = readTreasuryIntentEntry("ti_health")!;
    expect(() => {
      (snapshot as unknown as { settlement: string }).settlement = "finalized";
    }).toThrow();
    const before = store.entries["i:ti_health"].settlement;
    expect(before).toBe("ready");
  });

  it("损坏 store（entryCount 漂移）：写入拒绝、writer 阻断、聚合空但 blockers 报 blocking", () => {
    seedIntent("ti_corrupt", "ready");
    Memory.runtime!.treasury!.intents!.entryCount = 5; // 漂移
    resetTreasuryIntentRuntimeForTest();
    const service = makeService();
    const health = peekTreasuryIntentHealth();
    // 轻量探测查不出 entryCount 漂移？——entryCount 是轻量元数据，直接可见。
    expect(health.healthy).toBe(false);
    const write = writeTreasuryIntentEntry({
      transactionId: "ti_corrupt_write",
      digest: "0123456789abcdef",
      actionKind: "k",
      kind: "k",
      source: "s",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -1 }],
      outcome: "not_started",
      settlement: "ready",
      createdAtTick: Game.time,
      updatedAtTick: Game.time,
    });
    expect(write.status).toBe("rejected");
    expect(treasuryIntentBlockers().blocking).toBe(true);
    expect(treasuryIntentOutflowOccupancy().size).toBe(0); // 聚合不放宽
    expect(treasuryIntentCapacityOccupancy().size).toBe(0);
    // writer 阻断（fail closed）。
    const blocked = service.executePreparedAction(freshInput(service, "ti_corrupt_new"), () => ({ ok: true as const }));
    expect(blocked.status).toBe("prepare_rejected");
    if (blocked.status === "prepare_rejected") expect(blocked.reason).toBe("intent_store_fatal");
    // 原数据保留。
    expect(Memory.runtime!.treasury!.intents!.entries["i:ti_corrupt"]).toBeDefined();
  });

  it("未知版本 fail closed（原数据保留）", () => {
    seedIntent("ti_unknown", "ready");
    (Memory.runtime!.treasury!.intents as { version: number }).version = 7;
    resetTreasuryIntentRuntimeForTest();
    expect(peekTreasuryIntentHealth().healthy).toBe(false);
    expect(Memory.runtime!.treasury!.intents!.version).toBe(7); // 不重置
  });

  it("写入前重验 entry：非法 postings/phase/digest 结构化拒绝且 store 不变", () => {
    seedIntent("ti_valid", "ready");
    const before = Memory.runtime!.treasury!.intents!.entryCount;
    const bad1 = writeTreasuryIntentEntry({
      transactionId: "ti_bad",
      digest: "not-hex",
      actionKind: "k",
      kind: "k",
      source: "s",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -1 }],
      outcome: "not_started",
      settlement: "ready",
      createdAtTick: Game.time,
      updatedAtTick: Game.time,
    });
    expect(bad1.status).toBe("rejected");
    const bad2 = writeTreasuryIntentEntry({
      transactionId: "ti_bad2",
      digest: "0123456789abcdef",
      actionKind: "k",
      kind: "k",
      source: "s",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: 0 }],
      outcome: "not_started",
      settlement: "ready",
      createdAtTick: Game.time,
      updatedAtTick: Game.time,
    });
    expect(bad2.status).toBe("rejected");
    const bad3 = progressTreasuryIntent("ti_bad3", { outcome: "started_unknown", settlement: "authorized" as never });
    expect(bad3.status).toBe("rejected");
    expect(Memory.runtime!.treasury!.intents!.entryCount).toBe(before);
  });
});

describe("风险聚合（per-transaction 保守口径）", () => {
  it("intent 流出占用与容量占用（正流入占容量、负流出占资源，不抵消）", () => {
    seedIntent("ti_in", "executing", 1_000);
    seedIntent("ti_out", "executing", -500);
    const outflow = treasuryIntentOutflowOccupancy();
    const capacity = treasuryIntentCapacityOccupancy();
    expect(outflow.get(`W1N57\u0000storage\u0000${RESOURCE_ENERGY}`)).toBe(500); // 仅 ti_out 的 500
    expect(capacity.get("W1N57\u0000storage")).toBe(1_000); // 仅 ti_in 的 1000（不与 −500 抵消）
  });

  it("query 的 committed 计入 intent 流出占用", () => {
    const service = makeService();
    seedIntent("ti_q", "executing", -2_000);
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.committed).toBe(2_000); // intent 占用计入 committed（保守）
    expect(view.writeAdmission.blockers).toContain("intent_unresolved");
  });

  it("quarantine 释放后（resolution）intent 口径不再重复计入", () => {
    const service = makeService();
    seedIntent("ti_qq", "executing", -1_500);
    Game.time += 1;
    const next = makeService();
    next.beginTick(); // 转 quarantine
    releaseTreasuryQuarantineEntry("ti_qq"); // 模拟 resolution 完成
    const view = next.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.committed).toBe(0);
  });
});

describe("严格 phase 状态机与 phase 写失败（第九轮 4.4/4.5）", () => {
  it("progress 幂等仅在相同 digest/contract 下成立；不同 identity 拒绝", () => {
    seedIntent("ti_idem", "executing");
    // 同 identity 且已处于目标两轴的合法迁移：executing→faulted。
    const first = progressTreasuryIntent("ti_idem", { outcome: "started_unknown", settlement: "faulted", fromSettlement: ["executing"], digest: "0123456789abcdef" });
    expect(first.status).toBe("marked");
    // 幂等：再次迁移到同一目标（identity 相同）。
    const again = progressTreasuryIntent("ti_idem", { outcome: "started_unknown", settlement: "faulted", fromSettlement: ["executing"], digest: "0123456789abcdef" });
    expect(again.status).toBe("marked");
    // 不同 digest → identity_mismatch（绝不迁移）。
    const wrongDigest = progressTreasuryIntent("ti_idem", { outcome: "started_unknown", settlement: "quarantined", fromSettlement: ["faulted"], digest: "ffffffffffffffff" });
    expect(wrongDigest.status).toBe("rejected");
    if (wrongDigest.status === "rejected") expect(wrongDigest.reason).toBe("identity_mismatch");
    expect(readTreasuryIntentEntry("ti_idem")?.settlement).toBe("faulted");
    expect(readTreasuryIntentEntry("ti_idem")?.outcome).toBe("started_unknown");
  });

  it("前序 settlement 非法拒绝（ready→faulted 不可直达）；outcome 非单调拒绝（outcome_regression）", () => {
    seedIntent("ti_pred1", "ready");
    const direct = progressTreasuryIntent("ti_pred1", { outcome: "started_unknown", settlement: "faulted", fromSettlement: ["executing"], digest: "0123456789abcdef" });
    expect(direct.status).toBe("rejected");
    if (direct.status === "rejected") expect(direct.reason).toBe("predecessor_mismatch");
    // ready 相直接请求 returned_ok（跳过 started_unknown）→ outcome 单调拒绝。
    const skipOutcome = progressTreasuryIntent("ti_pred1", { outcome: "returned_ok", settlement: "pending_commit", fromSettlement: ["executing"], digest: "0123456789abcdef" });
    expect(skipOutcome.status).toBe("rejected");
    if (skipOutcome.status === "rejected") expect(skipOutcome.reason).toBe("outcome_regression");
    seedIntent("ti_pred2", "ok_pending_commit");
    // 已知 Game 返回 OK：outcome 事实不得退化为 returned_non_ok（第十轮单调表内建）。
    const downgrade = progressTreasuryIntent("ti_pred2", { outcome: "returned_non_ok", settlement: "faulted", fromSettlement: ["executing", "pending_commit"], digest: "0123456789abcdef" });
    expect(downgrade.status).toBe("rejected");
    if (downgrade.status === "rejected") expect(downgrade.reason).toBe("outcome_regression");
    expect(readTreasuryIntentEntry("ti_pred2")?.settlement).toBe("pending_commit");
    expect(readTreasuryIntentEntry("ti_pred2")?.outcome).toBe("returned_ok");
    // started_unknown 也不得在 OK 后回退。
    const toUnknown = progressTreasuryIntent("ti_pred2", { outcome: "started_unknown", settlement: "faulted", fromSettlement: ["pending_commit"], digest: "0123456789abcdef" });
    expect(toUnknown.status).toBe("rejected");
    if (toUnknown.status === "rejected") expect(toUnknown.reason).toBe("outcome_regression");
  });

  it("ready→executing 返回 not_found 时 callback 零调用（第九轮修复：不再忽略）", () => {
    const service = makeService();
    // read-back 需通过、transition 返回 not_found：spy 迁移函数模拟 entry
    // 在写入与迁移之间被外部移除（防御分支）。
    const spy = jest.spyOn(intentsModule, "progressTreasuryIntent").mockReturnValue({
      status: "rejected",
      reason: "not_found",
      detail: "intent entry 不存在（已释放或从未写入）",
    });
    let callbackCalls = 0;
    try {
      const result = service.executePreparedAction(freshInput(service, "ti_nf"), () => {
        callbackCalls += 1;
        return { ok: true as const };
      });
      expect(callbackCalls).toBe(0); // not_found → callback 零调用
      expect(result.status).toBe("prepare_rejected");
      if (result.status === "prepare_rejected") {
        expect(result.reason).toBe("intent_store_unavailable");
        expect(result.detail).toContain("not_found");
      }
    } finally {
      spy.mockRestore();
    }
  });
  it("read-back 验证不一致时 callback 零调用（写入后读回 digest 篡改）", () => {
    const service = makeService();
    // read-back 在同步实现下与写入同源（正常不可达）——该分支防御的是
    // store 写入层缺陷/外部串改；用 spy 模拟读回被篡改的 entry（digest
    // 与 record.digest 不同），验证 facade 在不一致时 callback 零调用。
    let callbackCalls = 0;
    const realReadTreasuryIntentEntry = intentsModule.readTreasuryIntentEntry;
    const spy = jest.spyOn(intentsModule, "readTreasuryIntentEntry").mockImplementation((transactionId: string) => {
      const entry = realReadTreasuryIntentEntry(transactionId);
      if (entry === undefined || callbackCalls > 0 || entry.settlement !== "ready") return entry;
      // 只篡改首次 ready 读回（read-back 点）。
      return Object.freeze({ ...entry, digest: "ffffffffffffffff" }) as typeof entry;
    });
    try {
      const result = service.executePreparedAction(freshInput(service, "ti_rb"), () => {
        callbackCalls += 1;
        return { ok: true as const };
      });
      expect(callbackCalls).toBe(0);
      expect(result.status).toBe("prepare_rejected");
      if (result.status === "prepare_rejected") {
        expect(result.reason).toBe("intent_store_unavailable");
        expect(result.detail).toContain("read-back");
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("callback 返回 OK 但 ok_pending_commit 落盘失败：不得普通 commit（executed_unsettled + durable fault）", () => {
    const service = makeService();
    let callbackCalls = 0;
    const result = service.executePreparedAction(freshInput(service, "ti_markfail"), () => {
      callbackCalls += 1;
      // callback 内破坏 store（version 置 99 + 失效 heap 缓存）：随后的
      // executing→ok_pending_commit 迁移触发 load fatal。
      (Memory.runtime!.treasury!.intents as { version: number }).version = 99;
      resetTreasuryIntentRuntimeForTest();
      return { ok: true as const };
    });
    expect(callbackCalls).toBe(1);
    expect(result.status).toBe("executed_unsettled");
    if (result.status === "executed_unsettled") {
      expect(result.faultReason).toBe("intent_phase_write_failed");
      expect(result.retryForbidden).toBe(true);
    }
    // durable fault：quarantine 接管权威（资产不释放）。
    expect(readTreasuryQuarantineEntry("ti_markfail")).toBeDefined();
  });

  it("callback 返回非 OK 但 returned_non_ok 落盘失败：不得普通 abort（executed_abort_failed + durable fault）", () => {
    const service = makeService();
    let callbackCalls = 0;
    const result = service.executePreparedAction(freshInput(service, "ti_markfail2"), () => {
      callbackCalls += 1;
      (Memory.runtime!.treasury!.intents as { version: number }).version = 99;
      resetTreasuryIntentRuntimeForTest();
      return { ok: false as const };
    });
    expect(callbackCalls).toBe(1);
    expect(result.status).toBe("executed_abort_failed");
    if (result.status === "executed_abort_failed") {
      expect(result.reason).toBe("intent_phase_write_failed");
    }
    expect(readTreasuryQuarantineEntry("ti_markfail2")).toBeDefined();
  });

  it("contract 路径的 intent 绑定完整合同身份（contractId/digest/adapterVersion/durablePayload）", () => {
    const service = makeService();
    let captured: ReturnType<typeof readTreasuryIntentEntry> = undefined;
    const result = service.executePreparedAction(
      freshInput(service, "ti_contract"),
      () => {
        captured = readTreasuryIntentEntry("ti_contract");
        return { ok: true as const };
      },
      {
        intentContract: {
          contractId: "ac:abcdef0123456789",
          contractDigest: "abcdef0123456789",
          adapterVersion: 3,
          durablePayload: "transfer|W1N57:storage|W1N57:terminal|energy|500",
          durablePayloadVersion: 1,
        },
      },
    );
    expect(result.status).toBe("executed_committed");
    expect(captured?.contractId).toBe("ac:abcdef0123456789");
    expect(captured?.contractDigest).toBe("abcdef0123456789");
    expect(captured?.adapterVersion).toBe(3);
    expect(captured?.durablePayload).toContain("transfer|");
    expect(captured?.durablePayloadVersion).toBe(1);
    expect(captured?.settlement).toBe("executing");
    expect(captured?.outcome).toBe("started_unknown");
  });

  it("intent contract identity 不匹配的 read-back 拒绝（contractId 不一致 → callback 零调用）", () => {
    const service = makeService();
    // spy 读回：ready 相的 entry 携带与 execution 声明不同的 contractId
    //（模拟写入层缺陷/串改）→ read-back identity 校验拒绝。
    let callbackCalls = 0;
    const realReadTreasuryIntentEntry = intentsModule.readTreasuryIntentEntry;
    const spy = jest.spyOn(intentsModule, "readTreasuryIntentEntry").mockImplementation((transactionId: string) => {
      const entry = realReadTreasuryIntentEntry(transactionId);
      if (entry === undefined || callbackCalls > 0 || entry.settlement !== "ready") return entry;
      return Object.freeze({ ...entry, contractId: "ac:ffffffffffffffff" }) as typeof entry;
    });
    try {
      const result = service.executePreparedAction(
        freshInput(service, "ti_cid"),
        () => {
          callbackCalls += 1;
          return { ok: true as const };
        },
        {
          intentContract: {
            contractId: "ac:0000000000000000",
            contractDigest: "0000000000000000",
            adapterVersion: 1,
          },
        },
      );
      expect(callbackCalls).toBe(0);
      expect(result.status).toBe("prepare_rejected");
      if (result.status === "prepare_rejected") {
        expect(result.reason).toBe("intent_store_unavailable");
        expect(result.detail).toContain("read-back");
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("store v1 数据迁移 v3（旧 phase → outcome/settlement 保守单调映射，version 推进）", () => {
    Memory.runtime = Memory.runtime ?? ({} as never);
    Memory.runtime.treasury = Memory.runtime.treasury ?? ({} as never);
    Memory.runtime.treasury.intents = {
      version: 1,
      entries: {
        "i:ti_v1": {
          transactionId: "ti_v1",
          digest: "0123456789abcdef",
          actionKind: "terminal.send",
          kind: "terminal.send",
          source: "test",
          postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -100 }],
          phase: "ready",
          createdAtTick: Game.time,
          updatedAtTick: Game.time,
        },
      },
      entryCount: 1,
      updatedAt: Game.time,
    } as never;
    resetTreasuryIntentRuntimeForTest();
    const health = peekTreasuryIntentHealth();
    expect(health.healthy).toBe(true);
    // 触发 load：read-back 或任何写路径访问 → v1 迁移 v3。
    const entry = readTreasuryIntentEntry("ti_v1");
    expect(entry?.transactionId).toBe("ti_v1");
    expect((Memory.runtime.treasury.intents as { version: number }).version).toBe(3);
    expect(Memory.runtime.treasury.intents.entries["i:ti_v1"].digest).toBe("0123456789abcdef");
    // 旧 phase "ready" → (not_started, ready)。
    expect(entry?.outcome).toBe("not_started");
    expect(entry?.settlement).toBe("ready");
    expect("phase" in (entry as object)).toBe(false); // 旧字段不残留
  });

  it("【第十轮 3.12.1】旧 phase 全集映射与未知 phase fail closed", () => {
    const expectations: Record<string, { outcome: string; settlement: string }> = {
      ready: { outcome: "not_started", settlement: "ready" },
      executing: { outcome: "started_unknown", settlement: "executing" },
      returned_non_ok: { outcome: "returned_non_ok", settlement: "pending_abort" },
      ok_pending_commit: { outcome: "returned_ok", settlement: "pending_commit" },
      committed: { outcome: "returned_ok", settlement: "finalized" },
      aborted: { outcome: "aborted_final", settlement: "finalized" },
      execution_unknown: { outcome: "started_unknown", settlement: "faulted" },
      quarantined: { outcome: "started_unknown", settlement: "quarantined" },
      resolution_pending: { outcome: "started_unknown", settlement: "resolving" },
    };
    for (const [legacy, expected] of Object.entries(expectations)) {
      const mapped = migrateTreasuryLegacyIntentPhase(legacy)!;
      expect(mapped.outcome).toBe(expected.outcome);
      expect(mapped.settlement).toBe(expected.settlement);
    }
    expect(migrateTreasuryLegacyIntentPhase("mystery_phase")).toBeNull();
    // 未知 phase 的 v2 store：load fail closed（原数据保留）。
    Memory.runtime = Memory.runtime ?? ({} as never);
    Memory.runtime.treasury = Memory.runtime.treasury ?? ({} as never);
    Memory.runtime.treasury.intents = {
      version: 2,
      entries: {
        "i:ti_bad_phase": {
          transactionId: "ti_bad_phase",
          digest: "0123456789abcdef",
          actionKind: "terminal.send",
          kind: "terminal.send",
          source: "test",
          postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -100 }],
          phase: "mystery_phase",
          createdAtTick: Game.time,
          updatedAtTick: Game.time,
        },
      },
      entryCount: 1,
      updatedAt: Game.time,
    } as never;
    resetTreasuryIntentRuntimeForTest();
    expect(readTreasuryIntentEntry("ti_bad_phase")).toBeUndefined(); // fatal → 不可信
    expect(peekTreasuryIntentHealth().healthy).toBe(false);
  });
});

describe("durable authority cohesion（第十轮 5.1：quarantine v2 完整合同事实）", () => {
  /** contract 路径的 execution options（完整合同身份 fixture）。 */
  const contractFacts = {
    contractId: "ac:abcdef0123456789",
    contractDigest: "abcdef0123456789",
    adapterVersion: 2,
    durablePayload: "transfer|W1N57:storage|W1N57:terminal|energy|500",
    durablePayloadVersion: 1,
    structureFacts: [
      { roomName: "W1N57", locationKind: "storage", structureId: "stor-1" },
      { roomName: "W1N57", locationKind: "terminal", structureId: "term-1" },
    ],
  };

  it("contract-backed intent 转 quarantine 后完整合同事实保留；global reset 后仍可重建", () => {
    const service = makeService();
    injectOnce("receipt_publish");
    const result = service.executePreparedAction(
      freshInput(service, "dac_full"),
      () => ({ ok: true as const }),
      { intentContract: contractFacts },
    );
    expect(result.status).toBe("executed_unsettled");
    const quarantined = readTreasuryQuarantineEntry("dac_full");
    expect(quarantined).toBeDefined();
    // v2 完整合同事实（不再依赖并存 intent）。
    expect(quarantined?.contractId).toBe("ac:abcdef0123456789");
    expect(quarantined?.contractDigest).toBe("abcdef0123456789");
    expect(quarantined?.adapterVersion).toBe(2);
    expect(quarantined?.durablePayload).toContain("transfer|");
    expect(quarantined?.durablePayloadVersion).toBe(1);
    expect(quarantined?.structureFacts).toEqual(contractFacts.structureFacts);
    expect(quarantined?.outcome).toBe("returned_ok"); // OK 事实保留
    expect(quarantined?.settlement).toBe("quarantined");
    // global reset（新 service + 恢复）后事实仍完整（reconciler 输入可重建）。
    Game.time += 1;
    const next = makeService();
    next.beginTick();
    const rebuilt = readTreasuryQuarantineEntry("dac_full");
    expect(rebuilt?.contractDigest).toBe("abcdef0123456789");
    expect(rebuilt?.adapterVersion).toBe(2);
    expect(rebuilt?.durablePayloadVersion).toBe(1);
    expect(rebuilt?.outcome).toBe("returned_ok");
    expect(readTreasuryIntentEntry("dac_full")).toBeUndefined(); // 事实已安全转移
  });

  it("事实转移读回不一致：intent 保留（emergency，绝不无验证释放）", () => {
    const service = makeService();
    void service;
    seedIntent("dac_rb", "executing");
    const spy = jest.spyOn(quarantineModule, "readTreasuryQuarantineEntry").mockImplementation((transactionId: string) => {
      const entry = realReadTreasuryQuarantineEntry(transactionId);
      // 篡改读回 digest（模拟 store 写入层缺陷）。
      if (entry !== undefined && entry.transactionId === "dac_rb") {
        return Object.freeze({ ...entry, digest: "ffffffffffffffff" }) as typeof entry;
      }
      return entry;
    });
    try {
      Game.time += 1;
      const next = makeService();
      next.beginTick(); // 恢复：转移写入成功但读回不一致 → intent 保留
      expect(readTreasuryIntentEntry("dac_rb")).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("v1 quarantine 迁移 v2：并存 intent 合同事实合并；无并存 intent 标记 legacyV1", () => {
    // 并存 intent（v3 直写，携带合同事实）。
    const withIntent = writeTreasuryIntentEntry({
      transactionId: "dac_mig1",
      digest: "0123456789abcdef",
      actionKind: "terminal.send",
      kind: "terminal.send",
      source: "test",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -500 }],
      outcome: "started_unknown",
      settlement: "executing",
      contractId: "ac:1111111111111111",
      contractDigest: "1111111111111111",
      adapterVersion: 3,
      createdAtTick: Game.time,
      updatedAtTick: Game.time,
    });
    expect(withIntent.status).toBe("written");
    Memory.runtime = Memory.runtime ?? ({} as never);
    Memory.runtime.treasury = Memory.runtime.treasury ?? ({} as never);
    Memory.runtime.treasury.quarantine = {
      version: 1,
      entries: {
        "q:dac_mig1": {
          transactionId: "dac_mig1",
          digest: "0123456789abcdef",
          tick: Game.time,
          kind: "terminal.send",
          source: "test",
          phase: "executing_at_end_tick",
          deltas: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -500 }],
          recordedAt: Game.time,
        },
        "q:dac_mig2": {
          transactionId: "dac_mig2",
          digest: "0123456789abcdef",
          tick: Game.time,
          kind: "terminal.send",
          source: "test",
          phase: "ok_pending_commit_unresolved",
          deltas: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -500 }],
          recordedAt: Game.time,
        },
      },
      entryCount: 2,
    } as never;
    resetTreasuryQuarantineRuntimeForTest();
    const merged = readTreasuryQuarantineEntry("dac_mig1");
    expect(merged?.outcome).toBe("started_unknown"); // phase 单调推导
    expect(merged?.settlement).toBe("quarantined");
    expect(merged?.contractDigest).toBe("1111111111111111"); // 并存 intent 合并
    expect(merged?.adapterVersion).toBe(3);
    expect(merged?.legacyV1).toBeUndefined();
    const legacy = readTreasuryQuarantineEntry("dac_mig2");
    expect(legacy?.outcome).toBe("returned_ok"); // commit 类 phase → returned_ok
    expect(legacy?.legacyV1).toBe(true); // 无并存 intent → legacy 标记
    expect((Memory.runtime.treasury.quarantine as { version: number }).version).toBe(2);
  });

  it("recovery slot：同 ID 双权威（转移窗口残留）只占一个 slot", () => {
    const service = makeService();
    seedIntent("dac_dup", "executing");
    // 直写同 id quarantine（模拟转移窗口/防御残留的双存在形态）。
    const write = quarantineTreasuryTransaction({
      transactionId: "dac_dup",
      digest: "0123456789abcdef",
      tick: Game.time,
      kind: "terminal.send",
      source: "test",
      phase: "executing_at_end_tick",
      outcome: "started_unknown",
      settlement: "quarantined",
      deltas: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -500 }],
      recordedAt: Game.time,
    });
    expect(write.status).toBe("written");
    const metrics = service.metrics();
    expect(metrics.durableIntents).toBe(1);
    expect(metrics.quarantineEntries).toBe(1);
    // 双存在同 ID 去重：只占一个 recovery slot。
    expect(metrics.quarantineSlotsRemaining).toBe(TREASURY_INTENT_MAX_ENTRIES - 1);
  });

  it("双权威 contractDigest 不一致 fail closed（capability 签发拒绝）", () => {
    // intent 携带 contractDigest A（直写）。
    const intentWrite = writeTreasuryIntentEntry({
      transactionId: "dac_conflict",
      digest: "0123456789abcdef",
      actionKind: "terminal.send",
      kind: "terminal.send",
      source: "test",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -500 }],
      outcome: "started_unknown",
      settlement: "executing",
      contractDigest: "1111111111111111",
      createdAtTick: Game.time,
      updatedAtTick: Game.time,
    });
    expect(intentWrite.status).toBe("written");
    // 直写 v2 quarantine 携带不同 contractDigest（模拟双权威不一致）。
    const qw = quarantineTreasuryTransaction({
      transactionId: "dac_conflict",
      digest: "0123456789abcdef",
      tick: Game.time,
      kind: "terminal.send",
      source: "test",
      phase: "executing_at_end_tick",
      outcome: "started_unknown",
      settlement: "quarantined",
      contractDigest: "2222222222222222",
      deltas: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -500 }],
      recordedAt: Game.time,
    });
    expect(qw.status).toBe("written");
    Game.time += 1;
    const next = makeService();
    next.beginTick();
    const issued = next.issueTreasuryReconciliationCapability({ transactionId: "dac_conflict" });
    expect(issued.status).toBe("rejected");
    if (issued.status === "rejected") expect(issued.reason).toBe("authority_inconsistent");
  });

  it("adapter v1 authority 在 registry 升级 v2 后：capability 签发拒绝（版本演进防护）", () => {
    const intentWrite = writeTreasuryIntentEntry({
      transactionId: "dac_ver",
      digest: "0123456789abcdef",
      actionKind: "test.transfer",
      kind: "test.transfer",
      source: "test",
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -500 }],
      outcome: "started_unknown",
      settlement: "executing",
      adapterVersion: 1,
      createdAtTick: Game.time,
      updatedAtTick: Game.time,
    });
    expect(intentWrite.status).toBe("written");
    Game.time += 1;
    const next = makeService();
    next.beginTick(); // 转 quarantine（adapterVersion=1 保留）
    expect(readTreasuryQuarantineEntry("dac_ver")?.adapterVersion).toBe(1);
    // registry 升级 v2（同 kind 覆盖注册）。
    registerTreasuryActionAdapter({ ...makeTreasuryTestTransferAdapter(), version: 2 });
    const issued = next.issueTreasuryReconciliationCapability({ transactionId: "dac_ver" });
    expect(issued.status).toBe("rejected");
    if (issued.status === "rejected") expect(issued.reason).toBe("adapter_version_mismatch");
  });
});
