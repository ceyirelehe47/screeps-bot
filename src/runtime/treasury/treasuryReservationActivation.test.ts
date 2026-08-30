/**
 * Treasury reservation schema activation 端到端测试（第七轮，经真实
 * TreasuryService 路径）：
 * - bootstrap 激活：beginTick 的 gate 在全部 planner/reservation writer
 *   之前完成（空店初始化 / legacy 自动迁移）；
 * - memoryCleanup 不是唯一激活路径（不经 17 tick 节拍也能激活）；
 * - 永不出现混合 store：v1/v2/v3 数据一经激活全部转为 v4 key；
 * - 迁移失败期间 mutation 结构化拒绝 + authorizationSafe/writeAdmission
 *   fail closed，修复后自动恢复。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";
import { reserveProductionResourceForOwner } from "@/runtime/resourceReservation";
import { installRooms, type RoomSpec } from "@mock/treasury";

const ROOMS: RoomSpec[] = [
  { name: "W1N57", storage: { id: "stor-1", resources: { energy: 100_000 }, freeCapacity: 10_000 }, terminal: null },
];

function makeService(): TreasuryTestService {
  const rooms = installRooms(ROOMS);
  const service = treasuryTestService(createTreasuryService({ getRooms: () => Object.values(rooms) }));
  service.beginTick();
  return treasuryTestService(service);
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  Memory.runtime = Memory.runtime ?? {};
  delete (Memory.runtime as { resourceReservationsOwnerVersion?: number }).resourceReservationsOwnerVersion;
  delete (Memory.runtime as { resourceReservationsCorrupted?: string }).resourceReservationsCorrupted;
});

describe("bootstrap activation（beginTick gate）", () => {
  it("空 store：beginTick 原子初始化当前版本，后续 mutation 直接新格式", () => {
    expect(Memory.runtime.resourceReservations).toBeUndefined();
    makeService();
    expect((Memory.runtime as { resourceReservationsOwnerVersion?: number }).resourceReservationsOwnerVersion).toBe(4);
    expect(
      reserveProductionResourceForOwner("W1N57", "energy", 100, { kind: "game-object", id: "a1b2c3d4e5f6a7b8c9d0e1f2" }),
    ).toEqual({ status: "ok", mutated: true });
    expect(Object.keys(Memory.runtime.resourceReservations!)).toEqual(["W1N57:energy:ow2:go:0:a1b2c3d4e5f6a7b8c9d0e1f2"]);
  });

  it("legacy store：beginTick 自动迁移（不经 memoryCleanup 的 17 tick 节拍）", () => {
    // v1 数据（version 缺失 + 裸 holderId key）。
    Memory.runtime.resourceReservations = {
      "W1N57:energy:carrier-legacy": {
        roomName: "W1N57", resource: "energy", holderId: "carrier-legacy",
        amount: 100, updatedAt: 1, expiresAt: Game.time + 500,
      },
    } as never;
    Game.time += 3; // 非 17 的倍数：memoryCleanup 不会运行
    makeService();
    const store = Memory.runtime.resourceReservations!;
    expect((Memory.runtime as { resourceReservationsOwnerVersion?: number }).resourceReservationsOwnerVersion).toBe(4);
    // 全部 key 为 v4 格式——无混合 store。
    expect(Object.keys(store)).toEqual(["W1N57:energy:ow2:lu:0:carrier-legacy"]);
    // 迁移后的授权正常（legacy 预留保守计入 committed）。
    const service = makeService();
    const view = service.query({ resource: "energy", rooms: ["W1N57"] });
    expect(view.committed).toBe(100);
    expect(view.authorizationSafe).toBe(true);
  });

  it("migration 失败：beginTick 计数、mutation 拒绝、authorizationSafe/writeAdmission fail closed，修复后恢复", () => {
    Memory.runtime.resourceReservations = {
      "W1N57:energy:broken": {
        roomName: "W1N57", resource: "energy", holderId: 42,
        amount: 100, updatedAt: 1, expiresAt: Game.time + 500,
      },
    } as never;
    const before = JSON.stringify(Memory.runtime.resourceReservations);
    const service = makeService();
    expect(service.metrics().reservationSchemaActivationFailures).toBeGreaterThan(0);
    // mutation 结构化拒绝（零写入）。
    expect(
      reserveProductionResourceForOwner("W1N57", "energy", 50, { kind: "game-object", id: "a1b2c3d4e5f6a7b8c9d0e1f2" }),
    ).toMatchObject({ status: "rejected", reason: "schema_not_ready" });
    expect(JSON.stringify(Memory.runtime.resourceReservations)).toBe(before);
    // 授权 fail closed。
    const view = service.query({ resource: "energy", rooms: ["W1N57"] });
    expect(view.authorizationSafe).toBe(false);
    expect(view.authorizationBlockers).toContain("reservation_migration_incomplete");
    expect(view.writeAdmission.ready).toBe(false);
    // 修复（人工移除损坏条目）后自动恢复（下一次 beginTick 激活）。
    delete Memory.runtime.resourceReservations!["W1N57:energy:broken"];
    Game.time += 1;
    const recovered = makeService();
    const after = recovered.query({ resource: "energy", rooms: ["W1N57"] });
    expect(after.authorizationSafe).toBe(true);
    expect(after.writeAdmission.ready).toBe(true);
  });

  it("typed 与 deprecated adapter 同一 gate：v1 store 下 legacy adapter 也先迁移后写入", () => {
    Memory.runtime.resourceReservations = {
      "W1N57:energy:carrier-legacy": {
        roomName: "W1N57", resource: "energy", holderId: "carrier-legacy",
        amount: 100, updatedAt: 1, expiresAt: Game.time + 500,
      },
    } as never;
    const { reserveProductionResource } = require("@/runtime/resourceReservation") as typeof import("@/runtime/resourceReservation");
    const result = reserveProductionResource("W1N57", "energy", 50, "task:abc");
    expect(result).toEqual({ status: "ok", mutated: true });
    const keys = Object.keys(Memory.runtime.resourceReservations!);
    expect((Memory.runtime as { resourceReservationsOwnerVersion?: number }).resourceReservationsOwnerVersion).toBe(4);
    expect(keys.every((key) => key.includes("ow2:"))).toBe(true); // 全部 v4——无混合
    expect(keys).toContain("W1N57:energy:ow2:tk:0:task:abc");
  });
});
