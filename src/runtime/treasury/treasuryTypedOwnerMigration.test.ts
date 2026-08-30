/**
 * Treasury typed reservation owner 权威测试（第五轮）：
 * - 持久化与聚合：game-object / logical-service owner 正常落库、键格式
 *   不变（marketSaleProtectionAdapter 兼容）、typed 聚合正确；
 * - 版本化迁移：legacy 裸 holderId → legacy-unresolved/已知 kind、
 *   room/resource/amount/expiresAt 不动、迁移后 revision bump、版本标记
 *   幂等短路、损坏条目不乐观忽略；
 * - 保守占用：legacy-unresolved 与暂时找不到的 game-object 都继续全额
 *   计入 committed，只有 expiresAt 或显式 release 解除；
 * - 自排除：完整 typed identity 比较（同字符串不同 kind 不互相排除）、
 *   logical owner 精确排除、legacy-unresolved 不允许被普通声明排除；
 * - 新 mutation API 不生成裸不明 holder（owner 字段恒持久化）。
 */
import {
  getReservedProductionAmountExcludingOwner,
  listProductionReservations,
  migrateResourceReservationsForTypedOwner,
  releaseProductionReservationForOwner,
  renewProductionReservationForOwner,
  reserveProductionResourceForOwner,
} from "@/runtime/resourceReservation";
import { resetTreasuryCommitmentRevisionForTest, readTreasuryCommitmentRevision } from "@/runtime/treasury/commitmentRevision";
import { buildTreasuryCommitmentIndex } from "@/runtime/treasury/commitments";
import { createTreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { installRooms, type RoomSpec } from "@mock/treasury";
import type { TreasuryOwnerIdentity } from "@/runtime/treasury/ownerIdentity";

const ROOMS: RoomSpec[] = [
  { name: "W1N57", storage: { id: "stor-1", resources: { energy: 100_000 }, freeCapacity: 10_000 }, terminal: null },
];

const GO_FACTORY = "a1b2c3d4e5f6a7b8c9d0e1f2";
const GO_OTHER = "b2c3d4e5f6a7b8c9d0e1f2a1";
const NUKE_LOGICAL = "nuker:a1b2c3d4e5f6a7b8c9d0e1f2:G";

function observation() {
  const rooms = installRooms(ROOMS);
  return createTreasuryService({ getRooms: () => Object.values(rooms) }).observation();
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  Memory.runtime = Memory.runtime ?? {};
  Memory.runtime.resourceReservations = {};
});

describe("typed owner 持久化与聚合", () => {
  it("game-object owner 正常持久化：store key/平铺字段不变，owner 字段落库", () => {
    reserveProductionResourceForOwner("W1N57", "energy", 500, { kind: "game-object", id: GO_FACTORY, roomName: "W1N57" }, 100);
    const store = Memory.runtime!.resourceReservations!;
    expect(Object.keys(store)).toEqual([`W1N57:energy:${GO_FACTORY}`]); // 键格式不变（adapter 兼容）
    const entry = store[`W1N57:energy:${GO_FACTORY}`]!;
    expect(entry.holderId).toBe(GO_FACTORY);
    expect(entry.amount).toBe(500);
    expect(entry.owner).toEqual({ kind: "game-object", id: GO_FACTORY, roomName: "W1N57" });
    expect(entry.expiresAt).toBe(Game.time + 100);
  });

  it("logical-service owner 正常持久化并聚合", () => {
    reserveProductionResourceForOwner("W1N57", "energy", 300, { kind: "logical-service", id: NUKE_LOGICAL, namespace: "nuker", roomName: "W1N57" });
    const entries = listProductionReservations();
    expect(entries).toHaveLength(1);
    expect(entries[0].owner?.kind).toBe("logical-service");
    expect(entries[0].owner?.namespace).toBe("nuker");
  });

  it("非法 owner identity 不落库（fail closed，不生成含义不明记录）", () => {
    reserveProductionResourceForOwner("W1N57", "energy", 100, { kind: "bogus" as never, id: "x" });
    reserveProductionResourceForOwner("W1N57", "energy", 100, { kind: "game-object", id: "" });
    expect(listProductionReservations()).toHaveLength(0);
  });

  it("renew / release typed API：续租更新、显式 release 解除占用", () => {
    const owner: TreasuryOwnerIdentity = { kind: "game-object", id: GO_FACTORY, roomName: "W1N57" };
    reserveProductionResourceForOwner("W1N57", "energy", 500, owner);
    renewProductionReservationForOwner("W1N57", "energy", 700, owner, 50);
    const entries = listProductionReservations();
    expect(entries[0].amount).toBe(700);
    expect(entries[0].expiresAt).toBe(Game.time + 50);
    releaseProductionReservationForOwner("W1N57", "energy", owner);
    expect(listProductionReservations()).toHaveLength(0);
  });
});

describe("legacy 迁移（版本化）", () => {
  it("legacy 未知字符串迁移为 legacy-unresolved；已知形状迁移为对应 kind；数值字段不动", () => {
    const store = Memory.runtime!.resourceReservations!;
    store["W1N57:energy:carrier1"] = { roomName: "W1N57", resource: "energy", holderId: "carrier1", amount: 100, updatedAt: 1, expiresAt: Game.time + 100 };
    store[`W1N57:energy:${GO_FACTORY}`] = { roomName: "W1N57", resource: "energy", holderId: GO_FACTORY, amount: 200, updatedAt: 1, expiresAt: Game.time + 100 };
    store[`W1N57:G:${NUKE_LOGICAL}`] = { roomName: "W1N57", resource: "G" as ResourceConstant, holderId: NUKE_LOGICAL, amount: 300, updatedAt: 1, expiresAt: Game.time + 100 };

    const report = migrateResourceReservationsForTypedOwner();
    expect(report.migrated).toBe(3);
    expect(report.damaged).toBe(0);
    expect(Memory.runtime!.resourceReservationsOwnerVersion).toBe(2);

    const migrated = Memory.runtime!.resourceReservations!;
    expect(migrated["W1N57:energy:carrier1"]!.owner).toEqual({ kind: "legacy-unresolved", id: "carrier1" });
    expect(migrated[`W1N57:energy:${GO_FACTORY}`]!.owner).toEqual({ kind: "game-object", id: GO_FACTORY });
    expect(migrated[`W1N57:G:${NUKE_LOGICAL}`]!.owner).toEqual({ kind: "logical-service", id: NUKE_LOGICAL, namespace: "nuker" });
    // room/resource/amount/expiresAt 保持不变；store key 不变。
    expect(migrated["W1N57:energy:carrier1"]!.amount).toBe(100);
    expect(migrated["W1N57:energy:carrier1"]!.expiresAt).toBe(Game.time + 100);
    expect(Object.keys(migrated).sort()).toEqual(["W1N57:G:nuker:a1b2c3d4e5f6a7b8c9d0e1f2:G".slice(0, 0) + `W1N57:G:${NUKE_LOGICAL}`, `W1N57:energy:${GO_FACTORY}`, "W1N57:energy:carrier1"].sort());
  });

  it("迁移 bump commitment revision（索引不得按旧口径继续聚合）", () => {
    const revisionBefore = readTreasuryCommitmentRevision();
    Memory.runtime!.resourceReservations!["W1N57:energy:carrier1"] = {
      roomName: "W1N57", resource: "energy", holderId: "carrier1", amount: 100, updatedAt: 1, expiresAt: Game.time + 100,
    };
    migrateResourceReservationsForTypedOwner();
    expect(readTreasuryCommitmentRevision()).toBeGreaterThan(revisionBefore);
  });

  it("迁移幂等：版本标记短路（二次执行零迁移零 bump）", () => {
    Memory.runtime!.resourceReservations!["W1N57:energy:carrier1"] = {
      roomName: "W1N57", resource: "energy", holderId: "carrier1", amount: 100, updatedAt: 1, expiresAt: Game.time + 100,
    };
    const first = migrateResourceReservationsForTypedOwner();
    expect(first.migrated).toBe(1);
    const revisionAfterFirst = readTreasuryCommitmentRevision();
    const second = migrateResourceReservationsForTypedOwner();
    expect(second.migrated).toBe(0);
    expect(readTreasuryCommitmentRevision()).toBe(revisionAfterFirst);
  });

  it("损坏条目（holderId 非字符串）不乐观忽略：原样保留计入 damaged", () => {
    Memory.runtime!.resourceReservations!["broken"] = {
      roomName: "W1N57", resource: "energy", holderId: 42 as never, amount: 100, updatedAt: 1, expiresAt: Game.time + 100,
    };
    const report = migrateResourceReservationsForTypedOwner();
    expect(report.migrated).toBe(0);
    expect(report.damaged).toBe(1);
    expect(Memory.runtime!.resourceReservations!.broken!.holderId).toBe(42 as never);
  });
});

describe("保守占用与 owner-aware 聚合", () => {
  function seedMixedStore(): void {
    const store = Memory.runtime!.resourceReservations!;
    store["W1N57:energy:carrier-legacy"] = { roomName: "W1N57", resource: "energy", holderId: "carrier-legacy", amount: 100, updatedAt: 1, expiresAt: Game.time + 100, owner: { kind: "legacy-unresolved", id: "carrier-legacy" } };
    store[`W1N57:energy:${GO_FACTORY}`] = { roomName: "W1N57", resource: "energy", holderId: GO_FACTORY, amount: 200, updatedAt: 1, expiresAt: Game.time + 100, owner: { kind: "game-object", id: GO_FACTORY } };
    store[`W1N57:energy:${GO_OTHER}`] = { roomName: "W1N57", resource: "energy", holderId: GO_OTHER, amount: 400, updatedAt: 1, expiresAt: Game.time + 100, owner: { kind: "game-object", id: GO_OTHER } };
  }

  it("legacy-unresolved 与找不到的 game-object 都全额计入 committed（missing ≠ 可支配）", () => {
    seedMixedStore();
    const index = buildTreasuryCommitmentIndex({
      tick: Game.time,
      tasks: {},
      reservations: Memory.runtime!.resourceReservations!,
      observation: observation(),
      holderExists: () => false, // 全部 owner 均无法确证存在
    });
    expect(index.reservedProduction("W1N57", "energy")).toBe(700);
    expect(index.metrics.missingOwnerStillCommitted).toBe(3);
    expect(index.metrics.typedOwnerResolved).toBe(0);
  });

  it("只有 expiresAt 到期（或显式 release）解除：到期条目不计入", () => {
    seedMixedStore();
    Memory.runtime!.resourceReservations![`W1N57:energy:${GO_OTHER}`]!.expiresAt = Game.time - 1;
    const index = buildTreasuryCommitmentIndex({
      tick: Game.time,
      tasks: {},
      reservations: Memory.runtime!.resourceReservations!,
      observation: observation(),
      holderExists: () => false,
    });
    expect(index.reservedProduction("W1N57", "energy")).toBe(300);
    expect(index.metrics.expiredReservationsExcluded).toBe(1);
  });

  it("同字符串不同 owner kind 不得互相排除（identity key 含 kind）", () => {
    seedMixedStore();
    // 同 id 字符串但声明为 logical-service：不排除 game-object 的预留。
    const asLogical = getReservedProductionAmountExcludingOwner("W1N57", "energy", {
      kind: "logical-service", id: GO_FACTORY, namespace: "nuker",
    });
    expect(asLogical).toBe(700);
    // 同 id 且同 kind：精确排除。
    const asGameObject = getReservedProductionAmountExcludingOwner("W1N57", "energy", {
      kind: "game-object", id: GO_FACTORY,
    });
    expect(asGameObject).toBe(500);
  });

  it("legacy-unresolved 不允许被普通 owner declaration 排除（查询层 fail closed）", () => {
    const rooms = installRooms(ROOMS);
    const treasury = createTreasuryService({
      getRooms: () => Object.values(rooms),
      getReservations: () => Memory.runtime!.resourceReservations!,
      resolveHolder: (holderId) =>
        holderId === "carrier-legacy" ? { kind: "game-object", roomName: "W1N57" } : undefined,
    });
    treasury.beginTick();
    seedMixedStore();
    // 声明 legacy 字符串为 game-object owner：运行时可解析（stub 放行），
    // 但预留的 owner kind 是 legacy-unresolved——identity 不匹配，绝不排除。
    const view = treasury.query({
      resource: "energy",
      rooms: ["W1N57"],
      owner: { ownerKind: "game-object", ownerId: "carrier-legacy", scope: "production-reservation", roomName: "W1N57" },
    });
    expect(view.ownerStatus).toBe("excluded-own-reservations");
    expect(view.committed).toBe(700); // carrier-legacy 的 100 照常扣除
  });

  it("logical owner 查询自身可精确排除", () => {
    const rooms = installRooms(ROOMS);
    Memory.runtime!.resourceReservations![`W1N57:G:${NUKE_LOGICAL}`] = {
      roomName: "W1N57", resource: "G" as ResourceConstant, holderId: NUKE_LOGICAL, amount: 150, updatedAt: 1, expiresAt: Game.time + 100,
      owner: { kind: "logical-service", id: NUKE_LOGICAL, namespace: "nuker" },
    };
    const treasury = createTreasuryService({
      getRooms: () => Object.values(rooms),
      getReservations: () => Memory.runtime!.resourceReservations!,
      resolveHolder: (holderId) =>
        holderId === NUKE_LOGICAL ? { kind: "logical", roomName: "W1N57" } : undefined,
    });
    treasury.beginTick();
    const view = treasury.query({
      resource: "G",
      rooms: ["W1N57"],
      owner: { ownerKind: "logical-service", ownerId: NUKE_LOGICAL, namespace: "nuker", scope: "production-reservation", roomName: "W1N57" },
    });
    expect(view.ownerStatus).toBe("excluded-own-reservations");
    expect(view.committed).toBe(0);
  });
});
