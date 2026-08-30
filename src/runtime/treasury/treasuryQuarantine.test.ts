/**
 * Treasury durable quarantine 测试（第六轮）：
 * - 普通 prepared（未执行）跨 tick 正常释放、不留 quarantine、可重新 prepare；
 * - executing（Game 结果未知）在 tick 边界进入 durable quarantine：占用快照
 *   （resourceDeltas/capacityDeltas）+ write-fault marker + 资源不释放；
 * - faulted（commit 写故障）在 tick 边界进入 quarantine（phase 保留根因）；
 * - quarantine 跨 global reset / 跨 service generation 存活：同 id prepare
 *   一律 transaction_quarantined；
 * - quarantine 计入授权计算（query committed 流出占用 + projectedFreeCapacity
 *   容量扣减），但不进入 committed projection（journal/overlay 不变）；
 * - 条目上限 + overflowed 持久标志。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { readTreasuryWriteFault, setTreasuryCommitFaultInjectorForTest, type TreasuryWriteFaultPhase } from "@/runtime/treasury/writeFault";
import {
  listTreasuryQuarantineEntries,
  quarantineTreasuryTransaction,
  readTreasuryQuarantineEntry,
  treasuryQuarantineBlockers,
  TREASURY_QUARANTINE_MAX_ENTRIES,
} from "@/runtime/treasury/quarantine";
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

  it("executing 在 tick 边界进入 durable quarantine：占用快照 + marker + 资源不释放", () => {
    const service = makeService();
    service.executePreparedAction(freshInput(service, "ts1_exec"), () => {
      service.endTick(); // executing 状态暴露给 tick 边界（Game 结果未知）
      return { ok: false as const };
    });
    const entries = listTreasuryQuarantineEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].transactionId).toBe("ts1_exec");
    expect(entries[0].phase).toBe("executing_at_end_tick");
    expect(entries[0].resourceDeltas).toEqual([
      { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -500 },
    ]);
    expect(entries[0].capacityDeltas).toEqual([
      { roomName: "W1N57", locationKind: "storage", resource: "", delta: -500 },
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
    expect(entry?.resourceDeltas[0]?.delta).toBe(-500);
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

  it("quarantine 计入授权计算：query committed 流出占用 + 容量扣减", () => {
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
    expect(second.projectedFreeCapacity("W1N57", "storage")).toBe(10_000 - 500);
    expect(treasuryQuarantineBlockers().blocking).toBe(true);
  });

  it("quarantine 有界：超上限置 overflowed 持久标志（占用事实不丢失）", () => {
    for (let index = 0; index < TREASURY_QUARANTINE_MAX_ENTRIES + 3; index += 1) {
      quarantineTreasuryTransaction({
        transactionId: `ts1_q${index}`,
        digest: "0000000000000000",
        tick: Game.time,
        kind: "test",
        source: "test",
        phase: "executing_at_end_tick",
        resourceDeltas: [],
        capacityDeltas: [],
        recordedAt: Game.time,
      });
    }
    const blockers = treasuryQuarantineBlockers();
    expect(blockers.unresolvedCount).toBe(TREASURY_QUARANTINE_MAX_ENTRIES);
    expect(blockers.overflowed).toBe(true);
    expect(blockers.blocking).toBe(true);
    // 溢出条目不静默丢弃 identity：首条仍在，超限条目被拒（重复写入幂等）。
    expect(readTreasuryQuarantineEntry("ts1_q0")).toBeDefined();
    expect(readTreasuryQuarantineEntry(`ts1_q${TREASURY_QUARANTINE_MAX_ENTRIES}`)).toBeUndefined();
  });
});
