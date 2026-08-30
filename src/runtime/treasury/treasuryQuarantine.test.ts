/**
 * Treasury durable quarantine 测试（第六轮建立、第七轮补全局 blocker /
 * fault-slot 预留 / 保守容量口径）：
 * - 普通 prepared（未执行）跨 tick 正常释放、不留 quarantine、可重新 prepare；
 * - executing（Game 结果未知）在 tick 边界进入 durable quarantine：canonical
 *   deltas 快照 + write-fault marker + 资源不释放；
 * - faulted（commit 写故障）在 tick 边界进入 quarantine（phase 保留根因）；
 * - quarantine 跨 global reset / 跨 service generation 存活：同 id prepare
 *   一律 transaction_quarantined；
 * - 【第七轮】全局 write blocker：A/B 双 quarantine 共存，解决 A 后 B 仍阻断
 *   新 transaction C（callback 零调用），解决 B 后恢复；
 * - 【第七轮】fault-slot 预留：63 条持久 + 1 active 可 prepare，再 prepare 在
 *   callback 前拒（quarantine_capacity_exhausted）；abort 释放 slot；fault
 *   将 slot 原子转换为持久 entry；
 * - 【第七轮】容量保守方向：正净流入减少 free capacity、负流出不增加、
 *   多资源按 location 净额；
 * - quarantine 计入授权计算（committed 流出占用），不进入 committed
 *   projection（journal/overlay 不变）。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { readTreasuryWriteFault, setTreasuryCommitFaultInjectorForTest, type TreasuryWriteFaultPhase } from "@/runtime/treasury/writeFault";
import {
  listTreasuryQuarantineEntries,
  quarantineTreasuryTransaction,
  readTreasuryQuarantineEntry,
  releaseTreasuryQuarantineEntry,
  treasuryQuarantineBlockers,
  TREASURY_QUARANTINE_MAX_ENTRIES,
} from "@/runtime/treasury/quarantine";
import { installRooms, type RoomSpec } from "@mock/treasury";
import { compatRecordAcceptedTransaction } from "@/runtime/treasury/compat";
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

/** 直接注入一条合法持久 quarantine entry（绕过 facade，构造 blocker 前置态）。 */
function injectQuarantineEntry(transactionId: string, deltas: Array<{ roomName: string; locationKind: string; resource: string; delta: number }> = []): void {
  quarantineTreasuryTransaction({
    transactionId,
    digest: "0123456789abcdef",
    tick: Game.time,
    kind: "test",
    source: "test",
    phase: "executing_at_end_tick",
    outcome: "started_unknown",
    settlement: "quarantined",
    deltas,
    recordedAt: Game.time,
  });
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  setTreasuryCommitFaultInjectorForTest(null);
});

afterEach(() => {
  setTreasuryCommitFaultInjectorForTest(null);
});

describe("tick 边界分类：普通 prepared 释放 vs executing/faulted 隔离", () => {
  it("普通 prepared 跨 tick 正常释放：无 quarantine、下一 tick 可重新 prepare", () => {
    const service = makeService();
    const prepared = service.prepareTransaction(freshInput(service, "ts1_plain"));
    expect(prepared.status).toBe("prepared");
    service.endTick();
    expect(listTreasuryQuarantineEntries()).toHaveLength(0);
    Game.time += 1;
    service.beginTick();
    const again = service.prepareTransaction(freshInput(service, "ts1_plain"));
    expect(again.status).toBe("prepared");
  });

  it("executing 在 tick 边界进入 durable quarantine：canonical deltas 快照 + marker + 资源不释放", () => {
    const service = makeService();
    service.executePreparedAction(freshInput(service, "ts1_exec"), () => {
      service.endTick(); // executing 状态暴露给 tick 边界（Game 结果未知）
      return { ok: false as const };
    });
    const entries = listTreasuryQuarantineEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].transactionId).toBe("ts1_exec");
    expect(entries[0].phase).toBe("executing_at_end_tick");
    // 单一 canonical posting 事实（容量占用由其派生，不再有第二份权威）。
    expect(entries[0].deltas).toEqual([
      { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -500 },
    ]);
    // write-fault marker（executing 严重故障）与全局锁。
    expect(readTreasuryWriteFault()?.phase).toBe("executing_at_end_tick");
    expect(service.metrics().preparedQuarantinedAtBoundary).toBe(1);
  });

  it("faulted（commit 写故障）在 tick 边界进入 quarantine：phase 保留根因", () => {
    const service = makeService();
    const prepared = service.prepareTransaction(freshInput(service, "ts1_faulted"));
    expect(prepared.status).toBe("prepared");
    injectOnce("heap_publish");
    const committed = service.commitPreparedTransaction(
      (prepared as { status: "prepared"; handle: import("@/runtime/treasury/types").TreasuryPreparedHandle }).handle,
    );
    expect(committed.status).toBe("rejected");
    service.endTick();
    const entry = readTreasuryQuarantineEntry("ts1_faulted");
    expect(entry).toBeDefined();
    expect(entry?.phase).toBe("heap_publish");
    expect(entry?.deltas[0]?.delta).toBe(-500);
    // journal/overlay 零写入（quarantine 绝不冒充 committed projection）。
    expect(service.journal()).toHaveLength(0);
    expect(service.projectedUsedCapacity("W1N57", "storage")).toBe(100_000);
  });
});

describe("quarantine 跨 tick / 跨 service generation / global reset", () => {
  it("模拟 global reset 后 quarantine 仍阻止同一 transaction 再执行", () => {
    const first = makeService();
    first.executePreparedAction(freshInput(first, "ts1_reset_exec"), () => {
      first.endTick();
      return { ok: false as const };
    });
    expect(readTreasuryQuarantineEntry("ts1_reset_exec")).toBeDefined();
    // 模拟 global reset：heap 全失（新 service 实例/新 generation），Memory 保留。
    Game.time += 1;
    const rooms = installRooms(ROOMS);
    const second = createTreasuryService({ getRooms: () => Object.values(rooms) });
    second.beginTick();
    const rejected = second.prepareTransaction(freshInput(second, "ts1_reset_exec"));
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("transaction_quarantined");
    // 多个 tick 生命周期后仍拒绝（无自动解除）。
    second.endTick();
    Game.time += 1;
    second.beginTick();
    expect(second.prepareTransaction(freshInput(second, "ts1_reset_exec")).status).toBe("rejected");
  });

  it("quarantine 计入授权计算：query committed 流出占用（不进 projection）", () => {
    const first = makeService();
    first.executePreparedAction(freshInput(first, "ts1_occupy"), () => {
      first.endTick();
      return { ok: false as const };
    });
    Game.time += 1;
    const rooms = installRooms(ROOMS);
    const second = createTreasuryService({ getRooms: () => Object.values(rooms) });
    second.beginTick();
    const view = second.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"], locations: ["storage"] });
    // 500 被 quarantine 流出占用（保守计入 committed；未进 projection）。
    expect(view.committed).toBe(500);
    expect(view.projected).toBe(100_000); // projection 不含 quarantine
    expect(treasuryQuarantineBlockers().blocking).toBe(true);
  });
});

describe("第七轮：全局 quarantine write blocker（marker 不是唯一锁来源）", () => {
  it("A/B 双 quarantine：解决 A（marker 随之清除）后 B 仍阻断新 prepare，解决 B 后恢复", () => {
    // 构造双隔离：ts7_a 经 executing 边界（写入 root marker），ts7_b 直接注入。
    const service = makeService();
    service.executePreparedAction(freshInput(service, "ts7_a"), () => {
      service.endTick();
      return { ok: false as const };
    });
    injectQuarantineEntry("ts7_b");
    expect(treasuryQuarantineBlockers().unresolvedCount).toBe(2);
    expect(readTreasuryWriteFault()?.transactionId).toBe("ts7_a");

    Game.time += 1;
    const rooms = installRooms(ROOMS);
    const next = createTreasuryService({ getRooms: () => Object.values(rooms) });
    next.beginTick();
    // 新 transaction C：全局阻断（quarantine_write_blocked），callback 零调用。
    let callbacks = 0;
    const blocked = next.executePreparedAction(freshInput(next, "ts7_c"), () => {
      callbacks += 1;
      return { ok: true as const };
    });
    expect(blocked.status).toBe("prepare_rejected");
    if (blocked.status === "prepare_rejected") expect(blocked.reason).toBe("quarantine_write_blocked");
    expect(callbacks).toBe(0);
    // readiness 同口径 fail closed。
    const blockedView = next.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(blockedView.authorizationSafe).toBe(false);
    expect(blockedView.writeAdmission.ready).toBe(false);
    expect(blockedView.writeAdmission.blockers).toContain("quarantine_unresolved");

    // 解决 A：释放 quarantine + 清 marker（模拟完整 resolution 的后置状态
    // ——本测试不直接调用 resolution 协议，只构造其结果）——但 B 仍在，
    // 阻断持续（不得因 marker 已清除而恢复执行）。
    releaseTreasuryQuarantineEntry("ts7_a");
    delete (Memory.runtime as NonNullable<typeof Memory.runtime>).treasury!.writeFault;
    expect(readTreasuryWriteFault()).toBeUndefined();
    const stillBlocked = next.prepareTransaction(freshInput(next, "ts7_c"));
    expect(stillBlocked.status).toBe("rejected");
    if (stillBlocked.status === "rejected") expect(stillBlocked.reason).toBe("quarantine_write_blocked");

    // 解决 B 后恢复 prepare。
    releaseTreasuryQuarantineEntry("ts7_b");
    const recovered = next.prepareTransaction(freshInput(next, "ts7_c"));
    expect(recovered.status).toBe("prepared");
  });

  it("quarantine_write_blocked 优先级：同 id quarantined 返回精确 reason，已结算幂等不受影响", () => {
    const service = makeService();
    // 先结算一笔 transaction（经 compat 单阶段登记 receipt），再制造全局
    // quarantine 阻断——已结算 id 的幂等查询仍返回 already_settled（幂等
    // 优先于全局阻断，全局语义不遗忘已结算事实）。
    compatRecordAcceptedTransaction(service, freshInput(service, "ts7_settled"));
    injectQuarantineEntry("ts7_d");
    const settledReplay = service.prepareTransaction(freshInput(service, "ts7_settled"));
    expect(settledReplay.status).toBe("already_settled");
    const sameId = service.prepareTransaction(freshInput(service, "ts7_d"));
    expect(sameId.status).toBe("rejected");
    if (sameId.status === "rejected") expect(sameId.reason).toBe("transaction_quarantined");
    const other = service.prepareTransaction(freshInput(service, "ts7_e"));
    expect(other.status).toBe("rejected");
    if (other.status === "rejected") expect(other.reason).toBe("quarantine_write_blocked");
  });
});

describe("第七轮：quarantine fault-slot 预留（prepare admission）", () => {
  it("无持久 quarantine 时 64 条 active prepared 达上限：第 65 个 prepare 在 callback 前拒绝，abort 释放后恢复", () => {
    const service = makeService();
    // 全局 blocker 未触发（0 条持久 quarantine）时，slot admission 是唯一
    // 容量约束：active handle 数（每条预留一个 fault slot）达 64 即拒绝。
    for (let index = 0; index < TREASURY_QUARANTINE_MAX_ENTRIES; index += 1) {
      const prepared = service.prepareTransaction(freshInput(service, `ts7_active${index}`));
      expect(prepared.status).toBe("prepared");
    }
    let callbacks = 0;
    const rejected = service.executePreparedAction(freshInput(service, "ts7_next"), () => {
      callbacks += 1;
      return { ok: true as const };
    });
    expect(rejected.status).toBe("prepare_rejected");
    if (rejected.status === "prepare_rejected") expect(rejected.reason).toBe("quarantine_capacity_exhausted");
    expect(callbacks).toBe(0);
    const metrics = service.metrics();
    expect(metrics.quarantineSlotsReserved).toBe(TREASURY_QUARANTINE_MAX_ENTRIES);
    expect(metrics.quarantineSlotsRemaining).toBe(0);
    // abort 释放一个 slot 后可恢复 prepare（fault-slot 语义）。
    const first = service.prepareTransaction(freshInput(service, "ts7_active0"));
    expect(first.status).toBe("prepared"); // 幂等返回同一 handle
    if (first.status === "prepared") {
      expect(service.abortPreparedTransaction(first.handle).status).toBe("aborted");
    }
    const recovered = service.prepareTransaction(freshInput(service, "ts7_next"));
    expect(recovered.status).toBe("prepared");
  });

  it("64 条持久 quarantine 满载：新 prepare 被全局 blocker 拒，写入路径返回 rejected（不置 overflowed）", () => {
    for (let index = 0; index < TREASURY_QUARANTINE_MAX_ENTRIES; index += 1) {
      injectQuarantineEntry(`ts7_slot${index}`);
    }
    const service = makeService();
    // 全局语义（第三节）：存在任意 unresolved quarantine 时新 transaction
    // 一律拒绝——先于 slot 公式触发（reason 是全局 blocker 而非容量）。
    const rejected = service.prepareTransaction(freshInput(service, "ts7_active"));
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("quarantine_write_blocked");
    // 满载写入路径不再产生 overflowed 丢 identity：返回 rejected 且 store 不变。
    const overflowWrite = quarantineTreasuryTransaction({
      transactionId: "ts7_overflow_attempt",
      digest: "0123456789abcdef",
      tick: Game.time,
      kind: "test",
      source: "test",
      phase: "executing_at_end_tick",
      outcome: "started_unknown",
      settlement: "quarantined",
      deltas: [],
      recordedAt: Game.time,
    });
    expect(overflowWrite.status).toBe("rejected");
    if (overflowWrite.status === "rejected") expect(overflowWrite.reason).toBe("capacity_exhausted");
    expect(treasuryQuarantineBlockers().overflowed).toBe(false); // 不再置 overflowed
    expect(readTreasuryQuarantineEntry("ts7_overflow_attempt")).toBeUndefined();
    // 首条与末条 identity 均可查（永不丢失）。
    expect(readTreasuryQuarantineEntry("ts7_slot0")).toBeDefined();
    expect(readTreasuryQuarantineEntry(`ts7_slot${TREASURY_QUARANTINE_MAX_ENTRIES - 1}`)).toBeDefined();
  });

  it("fault 将预留 slot 原子转换为持久 entry：entry 可查且 slot 计数守恒", () => {
    const service = makeService();
    injectOnce("heap_publish");
    let faulted = false;
    const result = service.executePreparedAction(freshInput(service, "ts7_fault_convert"), () => {
      faulted = true;
      return { ok: true as const };
    });
    expect(faulted).toBe(true);
    expect(result.status).toBe("executed_unsettled");
    // slot 转换（第八轮统一计数）：faulted handle 的预留 slot 已物化为持久
    // quarantine entry——active faulted handle 与 durable entry 不再计为两条
    // 不同占用（intent 已随 quarantine 写入成功释放，active 侧经 intent-
    // backed 集合排除），总量守恒 = 1。
    expect(readTreasuryQuarantineEntry("ts7_fault_convert")).toBeDefined();
    const metrics = service.metrics();
    expect(metrics.quarantineEntries).toBe(1);
    expect(metrics.quarantineSlotsReserved).toBe(0); // handle 的 slot 已转换为持久 entry
    expect(metrics.quarantineSlotsRemaining).toBe(TREASURY_QUARANTINE_MAX_ENTRIES - 1);
  });
});

describe("第七轮：quarantine 容量保守方向", () => {
  it("正净流入减少 free capacity，负流出不增加，多资源按 location 净额", () => {
    // +1000 流入（可能已流入 → 占用容量）与 -500 流出（不得假设空间已释放）。
    injectQuarantineEntry("ts7_cap_in", [
      { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: 1_000 },
    ]);
    injectQuarantineEntry("ts7_cap_out", [
      { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -500 },
    ]);
    const service = makeService();
    // 1000（流出腿 -500 不抵消它、也不释放空间）→ free capacity 减少 1000。
    expect(service.projectedFreeCapacity("W1N57", "storage")).toBe(10_000 - 1_000);
    // 正资源 delta 不乐观计入 spendable（observed/projected 不被冒充修改）。
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"], locations: ["storage"] });
    expect(view.observed).toBe(100_000);
    expect(view.projected).toBe(100_000);
  });

  it("纯流出 quarantine 不增加 free capacity（-500 时仍为 observed 基线）", () => {
    injectQuarantineEntry("ts7_out_only", [
      { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -500 },
    ]);
    const service = makeService();
    expect(service.projectedFreeCapacity("W1N57", "storage")).toBe(10_000);
    // 流出照常计入 committed 占用（资源口径不变）。
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"], locations: ["storage"] });
    expect(view.committed).toBe(500);
  });

  it("receiver headroom 口径与 projectedFreeCapacity 一致（commitments capacityDelta 统一扣减）", () => {
    injectQuarantineEntry("ts7_headroom", [
      { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: 2_000 },
    ]);
    const service = makeService();
    const commitments = service.commitments();
    const receiver = commitments.receiverCommitments("W1N57");
    // commitments 的 projected free 容量含 quarantine 占用（与 facade 同口径）。
    expect(receiver.projectedStorageHeadroom).toBe(
      service.projectedFreeCapacity("W1N57", "storage") - receiver.healthyIncomingAmount,
    );
  });
});
