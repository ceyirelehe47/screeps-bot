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
  readTreasuryQuarantineEntry,
  releaseTreasuryQuarantineEntry,
  resetTreasuryQuarantineRuntimeForTest,
} from "@/runtime/treasury/quarantine";
import {
  listTreasuryIntentEntries,
  transitionTreasuryIntentPhase,
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

/** 构造一条合法 intent entry（store 直写，恢复/权威测试用）。 */
function seedIntent(transactionId: string, phase: TreasuryIntentEntry["phase"], delta = -500): void {
  const write = writeTreasuryIntentEntry({
    transactionId,
    digest: "0123456789abcdef",
    actionKind: "terminal.send",
    kind: "terminal.send",
    source: "test",
    postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta }],
    phase,
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
      observedPhase = entry?.phase ?? "";
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
    };
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
    Memory.runtime!.treasury!.quarantine = { version: 1, entries: {}, entryCount: 0 };
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
    Memory.runtime!.treasury!.quarantine = { version: 1, entries: {}, entryCount: 0 };
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
    expect(store.version).toBe(2);
    expect(store.entryCount).toBe(1);
    // 冻结快照：外部修改不生效。
    const snapshot = readTreasuryIntentEntry("ti_health")!;
    expect(() => {
      (snapshot as unknown as { phase: string }).phase = "committed";
    }).toThrow();
    const before = store.entries["i:ti_health"].phase;
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
      phase: "ready",
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
      phase: "ready",
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
      phase: "ready",
      createdAtTick: Game.time,
      updatedAtTick: Game.time,
    });
    expect(bad2.status).toBe("rejected");
    const bad3 = transitionTreasuryIntentPhase("ti_bad3", { target: "authorized" as never, from: [] });
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
  it("transition 幂等仅在相同 digest/contract 下成立；不同 identity 拒绝", () => {
    seedIntent("ti_idem", "executing");
    // 同 identity 且已处于目标 phase 的合法前序迁移：executing→execution_unknown。
    const first = transitionTreasuryIntentPhase("ti_idem", { target: "execution_unknown", from: ["executing"], digest: "0123456789abcdef" });
    expect(first.status).toBe("marked");
    // 幂等：再次迁移到同一目标（identity 相同）。
    const again = transitionTreasuryIntentPhase("ti_idem", { target: "execution_unknown", from: ["executing"], digest: "0123456789abcdef" });
    expect(again.status).toBe("marked");
    // 不同 digest → identity_mismatch（绝不迁移）。
    const wrongDigest = transitionTreasuryIntentPhase("ti_idem", { target: "quarantined", from: ["execution_unknown"], digest: "ffffffffffffffff" });
    expect(wrongDigest.status).toBe("rejected");
    if (wrongDigest.status === "rejected") expect(wrongDigest.reason).toBe("identity_mismatch");
    expect(readTreasuryIntentEntry("ti_idem")?.phase).toBe("execution_unknown");
  });

  it("前序 phase 非法拒绝（ready→returned_non_ok 不可直达；ok_pending_commit 不得退化为 returned_non_ok）", () => {
    seedIntent("ti_pred1", "ready");
    const direct = transitionTreasuryIntentPhase("ti_pred1", { target: "returned_non_ok", from: ["executing"], digest: "0123456789abcdef" });
    expect(direct.status).toBe("rejected");
    if (direct.status === "rejected") expect(direct.reason).toBe("predecessor_mismatch");
    seedIntent("ti_pred2", "ok_pending_commit");
    // 已知 Game 返回 OK：不得退化为 returned_non_ok（事实单调性）。
    const downgrade = transitionTreasuryIntentPhase("ti_pred2", { target: "returned_non_ok", from: ["executing"], digest: "0123456789abcdef" });
    expect(downgrade.status).toBe("rejected");
    if (downgrade.status === "rejected") expect(downgrade.reason).toBe("predecessor_mismatch");
    expect(readTreasuryIntentEntry("ti_pred2")?.phase).toBe("ok_pending_commit");
  });

  it("ready→executing 返回 not_found 时 callback 零调用（第九轮修复：不再忽略）", () => {
    const service = makeService();
    // read-back 需通过、transition 返回 not_found：spy 迁移函数模拟 entry
    // 在写入与迁移之间被外部移除（防御分支）。
    const spy = jest.spyOn(intentsModule, "transitionTreasuryIntentPhase").mockReturnValue({
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
      if (entry === undefined || callbackCalls > 0 || entry.phase !== "ready") return entry;
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
    expect(captured?.phase).toBe("executing");
  });

  it("intent contract identity 不匹配的 read-back 拒绝（contractId 不一致 → callback 零调用）", () => {
    const service = makeService();
    // spy 读回：ready 相的 entry 携带与 execution 声明不同的 contractId
    //（模拟写入层缺陷/串改）→ read-back identity 校验拒绝。
    let callbackCalls = 0;
    const realReadTreasuryIntentEntry = intentsModule.readTreasuryIntentEntry;
    const spy = jest.spyOn(intentsModule, "readTreasuryIntentEntry").mockImplementation((transactionId: string) => {
      const entry = realReadTreasuryIntentEntry(transactionId);
      if (entry === undefined || callbackCalls > 0 || entry.phase !== "ready") return entry;
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

  it("store v1 数据无损升级 v2（entries 原样保留，version 推进）", () => {
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
    // 触发 load：read-back 或任何写路径访问 → v1 升级 v2。
    const entry = readTreasuryIntentEntry("ti_v1");
    expect(entry?.transactionId).toBe("ti_v1");
    expect((Memory.runtime.treasury.intents as { version: number }).version).toBe(2);
    expect(Memory.runtime.treasury.intents.entries["i:ti_v1"].digest).toBe("0123456789abcdef");
  });
});
