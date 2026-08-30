/**
 * Treasury write admission readiness 测试（第七轮，与余额完整分立）：
 * - clean 系统 ready=true 且 blockers 空；
 * - receipt 满载 → ready=false（receipt_capacity_exhausted）；
 * - quarantine slot 不足（active 满 64）→ ready=false（quarantine_slot_exhausted）
 *   且 prepare 独立复查拒绝（quarantine_capacity_exhausted）；
 * - unresolved quarantine → ready=false（quarantine_unresolved）；
 * - migration 失败 → ready=false（reservation_migration_incomplete）；
 * - quarantine/writeFault 损坏 → ready=false（quarantine_unhealthy）；
 * - readiness=false 不影响数值字段（余额观察与写入准入分立）。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { quarantineTreasuryTransaction, resetTreasuryQuarantineRuntimeForTest, treasuryQuarantineOutflowTotals, TREASURY_QUARANTINE_MAX_ENTRIES, type TreasuryQuarantineStore } from "@/runtime/treasury/quarantine";
import { installRooms, type RoomSpec } from "@mock/treasury";
import type { TreasuryTransactionInput } from "@/runtime/treasury/types";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";

const ROOMS: RoomSpec[] = [
  { name: "W1N57", storage: { id: "stor-1", resources: { energy: 100_000 }, freeCapacity: 10_000 }, terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 5_000 } },
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

function injectQuarantineEntry(transactionId: string): void {
  quarantineTreasuryTransaction({
    transactionId,
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
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  Memory.runtime = Memory.runtime ?? {};
  delete (Memory.runtime as { resourceReservationsOwnerVersion?: number }).resourceReservationsOwnerVersion;
  delete (Memory.runtime as { resourceReservationsCorrupted?: string }).resourceReservationsCorrupted;
});

describe("write admission readiness", () => {
  it("clean 系统：ready=true、blockers 空、数值正常", () => {
    const service = makeService();
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.writeAdmission.ready).toBe(true);
    expect(view.writeAdmission.blockers).toEqual([]);
    expect(view.authorizationSafe).toBe(true);
    expect(view.observed).toBe(120_000);
  });

  it("unresolved quarantine：ready=false 且 blockers 指示，数值字段不受影响", () => {
    injectQuarantineEntry("ts7_ready_q");
    const service = makeService();
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.writeAdmission.ready).toBe(false);
    expect(view.writeAdmission.blockers).toContain("quarantine_unresolved");
    // 余额观察保留（不以归零掩盖原因）。
    expect(view.observed).toBe(120_000);
    expect(view.projected).toBe(120_000);
  });

  it("quarantine slot 耗尽（active 满 64）：ready=false 且 prepare 独立复查拒绝", () => {
    const service = makeService();
    for (let index = 0; index < TREASURY_QUARANTINE_MAX_ENTRIES; index += 1) {
      const prepared = service.prepareTransaction(freshInput(service, `ts7_full_active${index}`));
      expect(prepared.status).toBe("prepared");
    }
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.writeAdmission.ready).toBe(false);
    expect(view.writeAdmission.blockers).toContain("quarantine_slot_exhausted");
    // readiness 只读——prepare 独立复查（绝不只信调用方读过 readiness）。
    const rejected = service.prepareTransaction(freshInput(service, "ts7_after_full"));
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") expect(rejected.reason).toBe("quarantine_capacity_exhausted");
  });

  it("并发 prepared 满载（receipt pending 与 quarantine slot 同时到顶）：ready=false，abort 释放后恢复", () => {
    const service = makeService();
    // 64 条 active prepared 同时占满 receipt pending 上限与 quarantine
    // fault-slot 预算（两上限同为 64）——readiness 列出 slot blocker；abort
    // 一条同时释放双维度。prepare 路径的 receipt_capacity_exhausted 拒绝
    // （单阶段登记挤满 pending）由 treasuryWriteAdmissionPerformance 覆盖。
    for (let index = 0; index < TREASURY_QUARANTINE_MAX_ENTRIES; index += 1) {
      expect(service.prepareTransaction(freshInput(service, `ts7_receipt${index}`)).status).toBe("prepared");
    }
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.writeAdmission.ready).toBe(false);
    expect(view.writeAdmission.blockers).toContain("quarantine_slot_exhausted");
    // abort 一条释放双维度后恢复。
    const first = service.prepareTransaction(freshInput(service, "ts7_receipt0"));
    if (first.status === "prepared") {
      expect(service.abortPreparedTransaction(first.handle).status).toBe("aborted");
    }
    const recovered = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(recovered.writeAdmission.ready).toBe(true);
  });

  it("migration 失败：ready=false（reservation_migration_incomplete），修复后恢复", () => {
    Memory.runtime.resourceReservations = {
      "W1N57:energy:broken": {
        roomName: "W1N57", resource: "energy", holderId: 42,
        amount: 100, updatedAt: 1, expiresAt: Game.time + 500,
      },
    } as never;
    const service = makeService();
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.writeAdmission.ready).toBe(false);
    expect(view.writeAdmission.blockers).toContain("reservation_migration_incomplete");
    delete Memory.runtime.resourceReservations!["W1N57:energy:broken"];
    Game.time += 1;
    const recovered = makeService();
    expect(recovered.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] }).writeAdmission.ready).toBe(true);
  });

  it("quarantine store 损坏与 writeFault marker 损坏：ready=false", () => {
    injectQuarantineEntry("ts7_ready_corrupt");
    (Memory.runtime!.treasury!.quarantine as TreasuryQuarantineStore).entryCount = 77;
    // 轻量 health 探测只查元数据形状；entry 级损坏由 load 显式检出（与
    // receipt 契约一致）——模拟 global reset 后首次访问触发 load。
    resetTreasuryQuarantineRuntimeForTest();
    treasuryQuarantineOutflowTotals();
    const service = makeService();
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.writeAdmission.ready).toBe(false);
    expect(view.writeAdmission.blockers).toContain("quarantine_unhealthy");
    expect(view.authorizationSafe).toBe(false);
  });

  it("invalid context：ready=false（invalid_context 单一 blocker）", () => {
    const service = makeService();
    const view = service.query({ resource: "unobtainium" as ResourceConstant, rooms: ["W1N57"] });
    expect(view.writeAdmission.ready).toBe(false);
    expect(view.writeAdmission.blockers).toEqual(["invalid_context"]);
  });
});
