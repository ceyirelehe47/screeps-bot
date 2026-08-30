/**
 * Treasury typed reservation owner 权威测试（第五轮建立、第六轮 v3 重做）：
 * - 持久化与聚合：game-object / logical-service owner 正常落库，store key
 *   编码完整 ownerToken（kind 前缀 + namespace 段 + id）；typed 聚合正确；
 * - 同 id 不同 kind / 不同 namespace 的 owner 在持久层彻底分离（v3 核心）：
 *   共存、独立 release、互不覆盖；
 * - 版本化原子迁移（v3）：临时结构全量验证 → 一次性引用切换 + version=3 +
 *   revision bump；数值字段不动；幂等短路；malformed / 新 key collision /
 *   key 与平铺字段不一致一律终止整个迁移（原数据不动、版本不推进）；
 * - 保守占用：legacy-unresolved 与暂时找不到的 game-object 都继续全额
 *   计入 committed，只有 expiresAt 或显式 release 解除；
 * - 自排除：完整 typed identity 比较（同字符串不同 kind 不互相排除）、
 *   logical owner 精确排除、legacy-unresolved 不允许被普通声明排除；
 * - 新 mutation API 不生成裸不明 holder（owner 字段恒持久化）。
 */
import {
  getReservedProductionAmountExcludingOwner,
  listProductionReservations,
  makeReservationStoreKey,
  migrateResourceReservationsForTypedOwner,
  releaseProductionReservationForOwner,
  renewProductionReservationForOwner,
  reserveProductionResourceForOwner,
  type ReservationOwnerMigrationReport,
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

function seedLegacyEntry(
  key: string,
  entry: { roomName: string; resource: string; holderId: string; amount: number; updatedAt: number; expiresAt: number; owner?: { kind: string; id: string; roomName?: string; namespace?: string } },
): void {
  Memory.runtime!.resourceReservations![key] = entry as never;
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  Memory.runtime = Memory.runtime ?? {};
  Memory.runtime.resourceReservations = {};
});

describe("typed owner 持久化与聚合（v3 key 编码完整 identity）", () => {
  it("game-object owner 持久化：store key 编码 ownerToken，平铺字段与 owner 字段落库", () => {
    reserveProductionResourceForOwner("W1N57", "energy", 500, { kind: "game-object", id: GO_FACTORY, roomName: "W1N57" }, 100);
    const store = Memory.runtime!.resourceReservations!;
    expect(Object.keys(store)).toEqual([`W1N57:energy:go:${GO_FACTORY}`]);
    const entry = store[`W1N57:energy:go:${GO_FACTORY}`]!;
    expect(entry.holderId).toBe(GO_FACTORY);
    expect(entry.amount).toBe(500);
    expect(entry.owner).toEqual({ kind: "game-object", id: GO_FACTORY, roomName: "W1N57" });
    expect(entry.expiresAt).toBe(Game.time + 100);
  });

  it("logical-service owner 持久化：token 含 namespace 段并正常聚合", () => {
    reserveProductionResourceForOwner("W1N57", "energy", 300, { kind: "logical-service", id: NUKE_LOGICAL, namespace: "nuker", roomName: "W1N57" });
    const store = Memory.runtime!.resourceReservations!;
    expect(Object.keys(store)).toEqual([`W1N57:energy:ls:nuker:${NUKE_LOGICAL}`]);
    const entries = listProductionReservations();
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

describe("同 id 不同 kind / namespace 的持久层隔离（v3 核心不变量）", () => {
  it("相同 id、不同 owner kind 共存且互不覆盖", () => {
    const sameId = GO_FACTORY;
    reserveProductionResourceForOwner("W1N57", "energy", 500, { kind: "game-object", id: sameId, roomName: "W1N57" });
    reserveProductionResourceForOwner("W1N57", "energy", 300, { kind: "legacy-unresolved", id: sameId });
    expect(listProductionReservations()).toHaveLength(2);
    expect(getReservedProductionAmountExcludingOwner("W1N57", "energy", { kind: "game-object", id: sameId })).toBe(300);
    expect(getReservedProductionAmountExcludingOwner("W1N57", "energy", { kind: "legacy-unresolved", id: sameId })).toBe(500);
  });

  it("相同 id、不同 namespace 的 logical-service 共存且互不覆盖", () => {
    reserveProductionResourceForOwner("W1N57", "energy", 100, { kind: "logical-service", id: "svc:x", namespace: "nuker", roomName: "W1N57" });
    reserveProductionResourceForOwner("W1N57", "energy", 200, { kind: "logical-service", id: "svc:x", namespace: "synthesis", roomName: "W1N57" });
    expect(listProductionReservations()).toHaveLength(2);
    expect(getReservedProductionAmountExcludingOwner("W1N57", "energy", { kind: "logical-service", id: "svc:x", namespace: "nuker" })).toBe(200);
    expect(getReservedProductionAmountExcludingOwner("W1N57", "energy", { kind: "logical-service", id: "svc:x", namespace: "synthesis" })).toBe(100);
  });

  it("release 一个 owner 不影响另一个（同 id 不同 kind）", () => {
    const sameId = GO_OTHER;
    reserveProductionResourceForOwner("W1N57", "energy", 500, { kind: "game-object", id: sameId, roomName: "W1N57" });
    reserveProductionResourceForOwner("W1N57", "energy", 300, { kind: "legacy-unresolved", id: sameId });
    releaseProductionReservationForOwner("W1N57", "energy", { kind: "game-object", id: sameId });
    const remaining = listProductionReservations();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].amount).toBe(300);
    expect(remaining[0].owner?.kind).toBe("legacy-unresolved");
    // 聚合维度只剩未被 release 的 owner。
    expect(getReservedProductionAmountExcludingOwner("W1N57", "energy", { kind: "legacy-unresolved", id: sameId })).toBe(0);
  });

  it("store key 拼接唯一权威：makeReservationStoreKey 与 mutation API 一致", () => {
    const owner: TreasuryOwnerIdentity = { kind: "logical-service", id: NUKE_LOGICAL, namespace: "nuker" };
    const expected = makeReservationStoreKey("W1N57", "G", owner);
    reserveProductionResourceForOwner("W1N57", "G", 100, owner);
    expect(Object.keys(Memory.runtime!.resourceReservations!)).toEqual([expected]);
  });
});

describe("版本化原子迁移（v3：key 重编码完整 ownerToken）", () => {
  it("legacy 迁移成功：未知字符串→legacy-unresolved、已知形状→对应 kind；key 重编码、数值不动、version=3", () => {
    seedLegacyEntry("W1N57:energy:carrier1", { roomName: "W1N57", resource: "energy", holderId: "carrier1", amount: 100, updatedAt: 1, expiresAt: Game.time + 100 });
    seedLegacyEntry(`W1N57:energy:${GO_FACTORY}`, { roomName: "W1N57", resource: "energy", holderId: GO_FACTORY, amount: 200, updatedAt: 1, expiresAt: Game.time + 100 });
    seedLegacyEntry(`W1N57:G:${NUKE_LOGICAL}`, { roomName: "W1N57", resource: "G", holderId: NUKE_LOGICAL, amount: 300, updatedAt: 1, expiresAt: Game.time + 100 });

    const report = migrateResourceReservationsForTypedOwner();
    expect(report.status).toBe("ok");
    expect(report.failure).toBeNull();
    expect(report.migrated).toBe(3);
    expect(Memory.runtime!.resourceReservationsOwnerVersion).toBe(3);

    const migrated = Memory.runtime!.resourceReservations!;
    expect(migrated["W1N57:energy:lu:carrier1"]!.owner).toEqual({ kind: "legacy-unresolved", id: "carrier1" });
    expect(migrated[`W1N57:energy:go:${GO_FACTORY}`]!.owner).toEqual({ kind: "game-object", id: GO_FACTORY });
    expect(migrated[`W1N57:G:ls:nuker:${NUKE_LOGICAL}`]!.owner).toEqual({ kind: "logical-service", id: NUKE_LOGICAL, namespace: "nuker" });
    // room/resource/amount/expiresAt 保持不变。
    expect(migrated["W1N57:energy:lu:carrier1"]!.amount).toBe(100);
    expect(migrated["W1N57:energy:lu:carrier1"]!.expiresAt).toBe(Game.time + 100);
    expect(Object.keys(migrated).sort()).toEqual(
      [`W1N57:G:ls:nuker:${NUKE_LOGICAL}`, `W1N57:energy:go:${GO_FACTORY}`, "W1N57:energy:lu:carrier1"].sort(),
    );
  });

  it("迁移 bump commitment revision（索引不得按旧口径继续聚合）", () => {
    const revisionBefore = readTreasuryCommitmentRevision();
    seedLegacyEntry("W1N57:energy:carrier1", { roomName: "W1N57", resource: "energy", holderId: "carrier1", amount: 100, updatedAt: 1, expiresAt: Game.time + 100 });
    migrateResourceReservationsForTypedOwner();
    expect(readTreasuryCommitmentRevision()).toBeGreaterThan(revisionBefore);
  });

  it("迁移幂等：版本标记短路（二次执行零迁移零 bump）", () => {
    seedLegacyEntry("W1N57:energy:carrier1", { roomName: "W1N57", resource: "energy", holderId: "carrier1", amount: 100, updatedAt: 1, expiresAt: Game.time + 100 });
    const first = migrateResourceReservationsForTypedOwner();
    expect(first.migrated).toBe(1);
    const revisionAfterFirst = readTreasuryCommitmentRevision();
    const second = migrateResourceReservationsForTypedOwner();
    expect(second.status).toBe("already-migrated");
    expect(second.migrated).toBe(0);
    expect(readTreasuryCommitmentRevision()).toBe(revisionAfterFirst);
  });

  it("迁移中途发现新 key collision：整个迁移终止、数据不部分修改、版本不推进", () => {
    // 两个不同 legacy holderId 携带相同 owner.id（v2 数据可能存在的重复声明）
    // → 重编码后新 key 相同 → collision。
    seedLegacyEntry("W1N57:energy:holder-a", { roomName: "W1N57", resource: "energy", holderId: "holder-a", amount: 100, updatedAt: 1, expiresAt: Game.time + 100, owner: { kind: "game-object", id: GO_FACTORY } });
    seedLegacyEntry("W1N57:energy:holder-b", { roomName: "W1N57", resource: "energy", holderId: "holder-b", amount: 200, updatedAt: 1, expiresAt: Game.time + 100, owner: { kind: "game-object", id: GO_FACTORY } });
    const before = JSON.stringify(Memory.runtime!.resourceReservations);

    const report = migrateResourceReservationsForTypedOwner();
    expect(report.status).toBe("ok");
    expect(report.failure).toContain("碰撞");
    expect(report.migrated).toBe(0);
    expect(Memory.runtime!.resourceReservationsOwnerVersion).toBeUndefined();
    // 原数据保持不动（零部分写入）。
    expect(JSON.stringify(Memory.runtime!.resourceReservations)).toBe(before);
  });

  it("迁移中途发现 malformed record：终止且不乐观忽略；修复后重复执行成功", () => {
    seedLegacyEntry("W1N57:energy:carrier1", { roomName: "W1N57", resource: "energy", holderId: "carrier1", amount: 100, updatedAt: 1, expiresAt: Game.time + 100 });
    seedLegacyEntry("W1N57:energy:broken", { roomName: "W1N57", resource: "energy", holderId: 42 as never, amount: 100, updatedAt: 1, expiresAt: Game.time + 100 });
    const before = JSON.stringify(Memory.runtime!.resourceReservations);

    const failed = migrateResourceReservationsForTypedOwner();
    expect(failed.failure).toContain("malformed");
    expect(Memory.runtime!.resourceReservationsOwnerVersion).toBeUndefined();
    expect(JSON.stringify(Memory.runtime!.resourceReservations)).toBe(before);

    // 修复方式 = 人工移除损坏条目（修复 key/holderId 不一致同样有效）；
    // 之后重复执行迁移成功（可重试）。
    delete Memory.runtime!.resourceReservations!["W1N57:energy:broken"];
    const repaired = migrateResourceReservationsForTypedOwner();
    expect(repaired.failure).toBeNull();
    expect(Memory.runtime!.resourceReservationsOwnerVersion).toBe(3);
  });

  it("迁移发现非法 owner 字段形状或 key 与平铺字段不一致：同样终止", () => {
    seedLegacyEntry("W1N57:energy:weird", { roomName: "W1N57", resource: "energy", holderId: "weird", amount: 100, updatedAt: 1, expiresAt: Game.time + 100, owner: { kind: 7 } as never });
    expect(migrateResourceReservationsForTypedOwner().failure).toContain("非法 owner");

    Memory.runtime!.resourceReservations = {};
    // key 与 entry 平铺字段不一致（外部篡改信号）。
    seedLegacyEntry("W0N0:energy:mismatch", { roomName: "W1N57", resource: "energy", holderId: "mismatch", amount: 100, updatedAt: 1, expiresAt: Game.time + 100 });
    const report: ReservationOwnerMigrationReport = migrateResourceReservationsForTypedOwner();
    expect(report.failure).toContain("不一致");
    expect(Memory.runtime!.resourceReservationsOwnerVersion).toBeUndefined();
  });
});

describe("保守占用与 owner-aware 聚合", () => {
  function seedMixedStore(): void {
    const store = Memory.runtime!.resourceReservations!;
    store["W1N57:energy:lu:carrier-legacy"] = { roomName: "W1N57", resource: "energy", holderId: "carrier-legacy", amount: 100, updatedAt: 1, expiresAt: Game.time + 100, owner: { kind: "legacy-unresolved", id: "carrier-legacy" } };
    store[`W1N57:energy:go:${GO_FACTORY}`] = { roomName: "W1N57", resource: "energy", holderId: GO_FACTORY, amount: 200, updatedAt: 1, expiresAt: Game.time + 100, owner: { kind: "game-object", id: GO_FACTORY } };
    store[`W1N57:energy:go:${GO_OTHER}`] = { roomName: "W1N57", resource: "energy", holderId: GO_OTHER, amount: 400, updatedAt: 1, expiresAt: Game.time + 100, owner: { kind: "game-object", id: GO_OTHER } };
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
    Memory.runtime!.resourceReservations![`W1N57:energy:go:${GO_OTHER}`]!.expiresAt = Game.time - 1;
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
    Memory.runtime!.resourceReservations![`W1N57:G:ls:nuker:${NUKE_LOGICAL}`] = {
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
