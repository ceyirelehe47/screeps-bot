/**
 * Treasury typed reservation owner 权威测试（第五轮建立、第六轮 v3、
 * 第七轮 v4 canonical owner token + schema activation gate）：
 * - 持久化与聚合：store key 编码 v4 canonical owner token（长度前缀
 *   `ow2:<kindCode>:<nsLen>:<namespace><id>`——冒号/Unicode/空格/空串无
 *   字段边界歧义）；固定 test vectors；
 * - 同 id 不同 kind / 不同 namespace 的 owner 在持久层彻底分离：共存、
 *   独立 release、互不覆盖；identity = kind+namespace+id（roomName/
 *   lifecycleRef 只是 metadata）；
 * - kind-specific validation：logical-service 的 namespace 必填、非
 *   logical-service 禁止 namespace；
 * - 版本化原子迁移 v4（legacy v1 / owner v2 / token v3 → v4）：以验证过的
 *   entry.owner 为权威重建 key、旧 key 按版本核验、碰撞/malformed/不一致
 *   终止整个迁移（原数据不动、版本不推进）、幂等、revision bump；
 * - schema activation gate（ensureReservationSchemaActivated）：空店初始化、
 *   legacy 先迁移、失败拒绝、corrupted 拒绝；
 * - 保守占用与 owner-aware 聚合（missing ≠ 可支配；同字符串不同 kind 不互
 *   相排除）。
 */
import {
  ensureReservationSchemaActivated,
  getReservedProductionAmountExcludingOwner,
  isReservationOwnerMigrationComplete,
  isReservationStoreCorrupted,
  listProductionReservations,
  makeReservationStoreKey,
  migrateResourceReservationsForTypedOwner,
  releaseProductionReservationForOwner,
  renewProductionReservationForOwner,
  repairReservationStoreCorruptionForRepair,
  reserveProductionResourceForOwner,
  type ReservationOwnerMigrationReport,
} from "@/runtime/resourceReservation";
import { resetTreasuryCommitmentRevisionForTest, readTreasuryCommitmentRevision } from "@/runtime/treasury/commitmentRevision";
import { buildTreasuryCommitmentIndex } from "@/runtime/treasury/commitments";
import { createTreasuryService } from "@/runtime/treasury/facade";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import {
  isValidTreasuryOwnerIdentity,
  treasuryReservationOwnerToken,
  type TreasuryOwnerIdentity,
} from "@/runtime/treasury/ownerIdentity";
import { installRooms, type RoomSpec } from "@mock/treasury";

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
  delete (Memory.runtime as { resourceReservationsOwnerVersion?: number }).resourceReservationsOwnerVersion;
  delete (Memory.runtime as { resourceReservationsCorrupted?: string }).resourceReservationsCorrupted;
});

describe("v4 canonical owner token（固定 test vectors，字段边界无歧义）", () => {
  it.each([
    ["namespace 'a' + id 'b:c' 与 namespace 'a:b' + id 'c' 不碰撞",
      { kind: "logical-service", id: "b:c", namespace: "a" } as TreasuryOwnerIdentity,
      { kind: "logical-service", id: "c", namespace: "a:b" } as TreasuryOwnerIdentity],
    ["同 id 不同 kind 不碰撞",
      { kind: "game-object", id: "x:y z", roomName: "W1N57" } as TreasuryOwnerIdentity,
      { kind: "task", id: "x:y z" } as TreasuryOwnerIdentity],
    ["同 id 不同 namespace 不碰撞",
      { kind: "logical-service", id: "svc", namespace: "nuker" } as TreasuryOwnerIdentity,
      { kind: "logical-service", id: "svc", namespace: "synthesis" } as TreasuryOwnerIdentity],
    ["Unicode / 空格 / 冒号 id 编码稳定",
      { kind: "legacy-unresolved", id: "怪 兵: Carrier" } as TreasuryOwnerIdentity,
      { kind: "legacy-unresolved", id: "怪兵:Carrier" } as TreasuryOwnerIdentity],
  ])("%s", (_label, left, right) => {
    expect(treasuryReservationOwnerToken(left)).not.toBe(treasuryReservationOwnerToken(right));
    // 同输入跨调用稳定。
    expect(treasuryReservationOwnerToken(left)).toBe(treasuryReservationOwnerToken(left));
  });

  it("长度前缀编码可从 nsLen 唯一还原 namespace/id 切分点（无隐含约定）", () => {
    expect(treasuryReservationOwnerToken({ kind: "logical-service", id: "b:c", namespace: "a" })).toBe("ow2:ls:1:ab:c");
    expect(treasuryReservationOwnerToken({ kind: "logical-service", id: "c", namespace: "a:b" })).toBe("ow2:ls:3:a:bc");
    expect(treasuryReservationOwnerToken({ kind: "game-object", id: GO_FACTORY })).toBe(`ow2:go:0:${GO_FACTORY}`);
    expect(treasuryReservationOwnerToken({ kind: "logical-service", id: NUKE_LOGICAL, namespace: "nuker" })).toBe(
      `ow2:ls:5:nuker${NUKE_LOGICAL}`,
    );
  });

  it("超长输入仍产出有界 token（id ≤128、namespace ≤64 由校验保证）", () => {
    const longId = "x".repeat(128);
    expect(treasuryReservationOwnerToken({ kind: "task", id: longId })).toBe(`ow2:tk:0:${longId}`);
    expect(isValidTreasuryOwnerIdentity({ kind: "task", id: "x".repeat(129) })).toBe(false);
    expect(isValidTreasuryOwnerIdentity({ kind: "logical-service", id: "ok", namespace: "n".repeat(65) })).toBe(false);
  });

  it("kind-specific validation：logical-service namespace 必填、非 logical-service 禁止", () => {
    expect(isValidTreasuryOwnerIdentity({ kind: "logical-service", id: "nuker:x" })).toBe(false); // 缺 namespace
    expect(isValidTreasuryOwnerIdentity({ kind: "logical-service", id: "nuker:x", namespace: "nuker" })).toBe(true);
    expect(isValidTreasuryOwnerIdentity({ kind: "game-object", id: GO_FACTORY, namespace: "nuker" } as never)).toBe(false); // 非 ls 禁止 namespace
    expect(isValidTreasuryOwnerIdentity({ kind: "game-object", id: GO_FACTORY })).toBe(true);
  });
});

describe("typed owner 持久化与聚合（v4 key 编码完整 identity）", () => {
  it("game-object owner 持久化：store key 编码 v4 token，平铺字段与 owner 字段落库", () => {
    const result = reserveProductionResourceForOwner("W1N57", "energy", 500, { kind: "game-object", id: GO_FACTORY, roomName: "W1N57" }, 100);
    expect(result).toEqual({ status: "ok", mutated: true });
    const store = Memory.runtime!.resourceReservations!;
    expect(Object.keys(store)).toEqual([`W1N57:energy:ow2:go:0:${GO_FACTORY}`]);
    const entry = store[`W1N57:energy:ow2:go:0:${GO_FACTORY}`]!;
    expect(entry.holderId).toBe(GO_FACTORY);
    expect(entry.amount).toBe(500);
    expect(entry.owner).toEqual({ kind: "game-object", id: GO_FACTORY, roomName: "W1N57" });
    expect(entry.expiresAt).toBe(Game.time + 100);
  });

  it("logical-service owner 持久化：token 含 nsLen 长度前缀并正常聚合", () => {
    reserveProductionResourceForOwner("W1N57", "energy", 300, { kind: "logical-service", id: NUKE_LOGICAL, namespace: "nuker", roomName: "W1N57" });
    const store = Memory.runtime!.resourceReservations!;
    expect(Object.keys(store)).toEqual([`W1N57:energy:ow2:ls:5:nuker${NUKE_LOGICAL}`]);
    const entries = listProductionReservations();
    expect(entries[0].owner?.kind).toBe("logical-service");
    expect(entries[0].owner?.namespace).toBe("nuker");
  });

  it("非法 owner identity 结构化拒绝（fail closed，不生成含义不明记录）", () => {
    expect(reserveProductionResourceForOwner("W1N57", "energy", 100, { kind: "bogus" as never, id: "x" })).toMatchObject({ status: "rejected", reason: "invalid_owner" });
    expect(reserveProductionResourceForOwner("W1N57", "energy", 100, { kind: "game-object", id: "" })).toMatchObject({ status: "rejected", reason: "invalid_owner" });
    expect(listProductionReservations()).toHaveLength(0);
  });

  it("renew / release typed API：续租更新、显式 release 解除占用（no-op 不 bump）", () => {
    const owner: TreasuryOwnerIdentity = { kind: "game-object", id: GO_FACTORY, roomName: "W1N57" };
    reserveProductionResourceForOwner("W1N57", "energy", 500, owner);
    const revisionAfterReserve = readTreasuryCommitmentRevision();
    // release 不存在的组合：no-op 不 bump。
    expect(releaseProductionReservationForOwner("W1N57", "U" as ResourceConstant, owner)).toEqual({ status: "ok", mutated: false });
    expect(readTreasuryCommitmentRevision()).toBe(revisionAfterReserve);
    // renew 不存在的组合：no-op 不创建不 bump。
    expect(renewProductionReservationForOwner("W1N57", "U" as ResourceConstant, 10, owner)).toEqual({ status: "ok", mutated: false });
    expect(readTreasuryCommitmentRevision()).toBe(revisionAfterReserve);
    // 续租：实际更新恰好 bump 一次。
    expect(renewProductionReservationForOwner("W1N57", "energy", 700, owner, 50)).toEqual({ status: "ok", mutated: true });
    expect(readTreasuryCommitmentRevision()).toBe(revisionAfterReserve + 1);
    const entries = listProductionReservations();
    expect(entries[0].amount).toBe(700);
    expect(entries[0].expiresAt).toBe(Game.time + 50);
    expect(releaseProductionReservationForOwner("W1N57", "energy", owner)).toEqual({ status: "ok", mutated: true });
    expect(listProductionReservations()).toHaveLength(0);
  });

  it("listProductionReservations 返回冻结深拷贝：外部修改不影响 Memory", () => {
    const owner: TreasuryOwnerIdentity = { kind: "game-object", id: GO_FACTORY };
    reserveProductionResourceForOwner("W1N57", "energy", 500, owner);
    const snapshot = listProductionReservations();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    expect(Object.isFrozen(snapshot[0].owner)).toBe(true);
    // 深拷贝：改 snapshot 不改 Memory（mutation 尝试在严格模式下抛错或被忽略）。
    const rawEntry = Memory.runtime!.resourceReservations![`W1N57:energy:ow2:go:0:${GO_FACTORY}`]!;
    expect((snapshot[0] as unknown as { amount: number }).amount).toBe(rawEntry.amount);
    expect(() => {
      (snapshot[0] as unknown as { amount: number }).amount = 999;
    }).toThrow(); // 冻结对象在 strict mode 下拒绝写入
    expect(rawEntry.amount).toBe(500);
    expect(() => {
      (snapshot[0].owner as unknown as { id: string }).id = "tampered";
    }).toThrow();
    expect(rawEntry.owner!.id).toBe(GO_FACTORY);
  });
});

describe("同 id 不同 kind / namespace 的持久层隔离（v4 核心不变量）", () => {
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
    expect(getReservedProductionAmountExcludingOwner("W1N57", "energy", { kind: "legacy-unresolved", id: sameId })).toBe(0);
  });

  it("store key 拼接唯一权威：makeReservationStoreKey 与 mutation API 一致", () => {
    const owner: TreasuryOwnerIdentity = { kind: "logical-service", id: NUKE_LOGICAL, namespace: "nuker" };
    const expected = makeReservationStoreKey("W1N57", "G", owner);
    reserveProductionResourceForOwner("W1N57", "G", 100, owner);
    expect(Object.keys(Memory.runtime!.resourceReservations!)).toEqual([expected]);
  });
});

describe("schema activation gate（第七轮：激活先于一切 mutation）", () => {
  it("空 store 首次 gate/mutation 自动激活当前版本（version=4）", () => {
    const gate = ensureReservationSchemaActivated();
    expect(gate.status).toBe("ready");
    expect((Memory.runtime as { resourceReservationsOwnerVersion?: number }).resourceReservationsOwnerVersion).toBe(4);
    expect(isReservationOwnerMigrationComplete()).toBe(true);
  });

  it("legacy store（v1）mutation 前先迁移：无混合 key，mutation 生效", () => {
    seedLegacyEntry("W1N57:energy:carrier1", { roomName: "W1N57", resource: "energy", holderId: "carrier1", amount: 100, updatedAt: 1, expiresAt: Game.time + 100 });
    expect(isReservationOwnerMigrationComplete()).toBe(false);
    // mutation 触发 gate → 自动迁移到 v4 → mutation 在纯 v4 store 上执行。
    const result = reserveProductionResourceForOwner("W1N57", "energy", 50, { kind: "game-object", id: GO_FACTORY });
    expect(result).toEqual({ status: "ok", mutated: true });
    expect((Memory.runtime as { resourceReservationsOwnerVersion?: number }).resourceReservationsOwnerVersion).toBe(4);
    const keys = Object.keys(Memory.runtime!.resourceReservations!);
    // 全部 key 都是 v4 格式（含 ow2: token）——绝无混合 store。
    expect(keys.every((key) => key.includes("ow2:"))).toBe(true);
    expect(keys).toContain("W1N57:energy:ow2:lu:0:carrier1");
    expect(keys).toContain(`W1N57:energy:ow2:go:0:${GO_FACTORY}`);
  });

  it("migration 失败时 mutation 结构化拒绝（零写入）、授权 fail closed", () => {
    seedLegacyEntry("W1N57:energy:broken", { roomName: "W1N57", resource: "energy", holderId: 42 as never, amount: 100, updatedAt: 1, expiresAt: Game.time + 100 });
    const before = JSON.stringify(Memory.runtime!.resourceReservations);
    const gate = ensureReservationSchemaActivated();
    expect(gate.status).toBe("rejected");
    if (gate.status === "rejected") expect(gate.reason).toBe("migration_failed");
    const result = reserveProductionResourceForOwner("W1N57", "energy", 50, { kind: "game-object", id: GO_FACTORY });
    expect(result).toMatchObject({ status: "rejected", reason: "schema_not_ready" });
    expect(JSON.stringify(Memory.runtime!.resourceReservations)).toBe(before); // 零写入
    expect(isReservationOwnerMigrationComplete()).toBe(false);
  });

  it("未知版本 fail closed；corrupted 标志 fail closed 且显式 repair 可解除", () => {
    // 非空 store + 未知版本（空 store 无可迁移数据，gate 会安全初始化当前版本）。
    seedLegacyEntry("W1N57:energy:carrier1", { roomName: "W1N57", resource: "energy", holderId: "carrier1", amount: 100, updatedAt: 1, expiresAt: Game.time + 100 });
    (Memory.runtime as { resourceReservationsOwnerVersion?: number }).resourceReservationsOwnerVersion = 9;
    const gate = ensureReservationSchemaActivated();
    expect(gate.status).toBe("rejected");
    if (gate.status === "rejected") expect(gate.reason).toBe("unknown_version");
    // corrupted 标志（GC 置位语义）。
    (Memory.runtime as { resourceReservationsOwnerVersion?: number }).resourceReservationsOwnerVersion = undefined;
    (Memory.runtime as { resourceReservationsCorrupted?: string }).resourceReservationsCorrupted = "gc 发现 1 条 malformed";
    expect(isReservationStoreCorrupted()).toBe(true);
    expect(ensureReservationSchemaActivated()).toMatchObject({ status: "rejected", reason: "store_corrupted" });
    // 显式 repair：验证全 store 合法后清除。
    expect(repairReservationStoreCorruptionForRepair().status).toBe("repaired");
    expect(isReservationStoreCorrupted()).toBe(false);
    expect(ensureReservationSchemaActivated().status).toBe("ready");
  });
});

describe("版本化原子迁移（v4：legacy v1 / owner v2 / token v3 → v4）", () => {
  it("legacy v1 迁移成功：未知字符串→legacy-unresolved、已知形状→对应 kind；key 重编码、数值不动、version=4", () => {
    seedLegacyEntry("W1N57:energy:carrier1", { roomName: "W1N57", resource: "energy", holderId: "carrier1", amount: 100, updatedAt: 1, expiresAt: Game.time + 100 });
    seedLegacyEntry(`W1N57:energy:${GO_FACTORY}`, { roomName: "W1N57", resource: "energy", holderId: GO_FACTORY, amount: 200, updatedAt: 1, expiresAt: Game.time + 100 });
    seedLegacyEntry(`W1N57:G:${NUKE_LOGICAL}`, { roomName: "W1N57", resource: "G", holderId: NUKE_LOGICAL, amount: 300, updatedAt: 1, expiresAt: Game.time + 100 });

    const report = migrateResourceReservationsForTypedOwner();
    expect(report.status).toBe("ok");
    expect(report.failure).toBeNull();
    expect(report.migrated).toBe(3);
    expect((Memory.runtime as { resourceReservationsOwnerVersion?: number }).resourceReservationsOwnerVersion).toBe(4);

    const migrated = Memory.runtime!.resourceReservations!;
    expect(migrated["W1N57:energy:ow2:lu:0:carrier1"]!.owner).toEqual({ kind: "legacy-unresolved", id: "carrier1" });
    expect(migrated[`W1N57:energy:ow2:go:0:${GO_FACTORY}`]!.owner).toEqual({ kind: "game-object", id: GO_FACTORY });
    expect(migrated[`W1N57:G:ow2:ls:5:nuker${NUKE_LOGICAL}`]!.owner).toEqual({ kind: "logical-service", id: NUKE_LOGICAL, namespace: "nuker" });
    // room/resource/amount/expiresAt 保持不变。
    expect(migrated["W1N57:energy:ow2:lu:0:carrier1"]!.amount).toBe(100);
    expect(migrated["W1N57:energy:ow2:lu:0:carrier1"]!.expiresAt).toBe(Game.time + 100);
    expect(Object.keys(migrated).sort()).toEqual(
      [`W1N57:G:ow2:ls:5:nuker${NUKE_LOGICAL}`, `W1N57:energy:ow2:go:0:${GO_FACTORY}`, "W1N57:energy:ow2:lu:0:carrier1"].sort(),
    );
  });

  it("v3 → v4 迁移：以验证过的 entry.owner 为权威重建 key（logical-service 缺 namespace 按注册表前缀补全）", () => {
    // v3 存量：key 为 v3 token；owner 半 typed（logical-service 缺 namespace——
    // 第六轮校验未要求），迁移以 entry.owner 为权威 + id 前缀无损补全。
    Memory.runtime!.resourceReservations!["W1N57:energy:ls:synthesis:synthesis:room1"] = {
      roomName: "W1N57", resource: "energy", holderId: "synthesis:room1", amount: 120, updatedAt: 1, expiresAt: Game.time + 100,
      owner: { kind: "logical-service", id: "synthesis:room1" },
    } as never;
    Memory.runtime!.resourceReservations![`W1N57:energy:go:${GO_FACTORY}`] = {
      roomName: "W1N57", resource: "energy", holderId: GO_FACTORY, amount: 80, updatedAt: 1, expiresAt: Game.time + 100,
      owner: { kind: "game-object", id: GO_FACTORY },
    } as never;
    (Memory.runtime as { resourceReservationsOwnerVersion?: number }).resourceReservationsOwnerVersion = 3;

    const report = migrateResourceReservationsForTypedOwner();
    expect(report.failure).toBeNull();
    const migrated = Memory.runtime!.resourceReservations!;
    // namespace 补全为 "synthesis"（id 注册表前缀，len 9）→ v4 token。
    expect(migrated["W1N57:energy:ow2:ls:9:synthesissynthesis:room1"]!.owner).toEqual({ kind: "logical-service", id: "synthesis:room1", namespace: "synthesis" });
    expect(migrated[`W1N57:energy:ow2:go:0:${GO_FACTORY}`]!.owner).toEqual({ kind: "game-object", id: GO_FACTORY });
    expect((Memory.runtime as { resourceReservationsOwnerVersion?: number }).resourceReservationsOwnerVersion).toBe(4);
  });

  it("v3 数据 key 与 owner token 不一致（篡改信号）：终止迁移", () => {
    Memory.runtime!.resourceReservations!["W1N57:energy:ls:synthesis:other-id"] = {
      roomName: "W1N57", resource: "energy", holderId: "synthesis:room1", amount: 120, updatedAt: 1, expiresAt: Game.time + 100,
      owner: { kind: "logical-service", id: "synthesis:room1" },
    } as never;
    (Memory.runtime as { resourceReservationsOwnerVersion?: number }).resourceReservationsOwnerVersion = 3;
    const report = migrateResourceReservationsForTypedOwner();
    expect(report.failure).toContain("不一致");
    expect((Memory.runtime as { resourceReservationsOwnerVersion?: number }).resourceReservationsOwnerVersion).toBe(3);
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
    expect((Memory.runtime as { resourceReservationsOwnerVersion?: number }).resourceReservationsOwnerVersion).toBeUndefined();
    expect(JSON.stringify(Memory.runtime!.resourceReservations)).toBe(before);
  });

  it("迁移中途发现 malformed record：终止且不乐观忽略；修复后重复执行成功", () => {
    seedLegacyEntry("W1N57:energy:carrier1", { roomName: "W1N57", resource: "energy", holderId: "carrier1", amount: 100, updatedAt: 1, expiresAt: Game.time + 100 });
    seedLegacyEntry("W1N57:energy:broken", { roomName: "W1N57", resource: "energy", holderId: 42 as never, amount: 100, updatedAt: 1, expiresAt: Game.time + 100 });
    const before = JSON.stringify(Memory.runtime!.resourceReservations);

    const failed = migrateResourceReservationsForTypedOwner();
    expect(failed.failure).toContain("malformed");
    expect((Memory.runtime as { resourceReservationsOwnerVersion?: number }).resourceReservationsOwnerVersion).toBeUndefined();
    expect(JSON.stringify(Memory.runtime!.resourceReservations)).toBe(before);

    // 修复方式 = 人工移除损坏条目；之后重复执行迁移成功（可重试）。
    delete Memory.runtime!.resourceReservations!["W1N57:energy:broken"];
    const repaired = migrateResourceReservationsForTypedOwner();
    expect(repaired.failure).toBeNull();
    expect((Memory.runtime as { resourceReservationsOwnerVersion?: number }).resourceReservationsOwnerVersion).toBe(4);
  });

  it("迁移发现非法 owner 字段形状或 key 与平铺字段不一致：同样终止", () => {
    seedLegacyEntry("W1N57:energy:weird", { roomName: "W1N57", resource: "energy", holderId: "weird", amount: 100, updatedAt: 1, expiresAt: Game.time + 100, owner: { kind: 7 } as never });
    expect(migrateResourceReservationsForTypedOwner().failure).toContain("非法 owner");

    Memory.runtime!.resourceReservations = {};
    delete (Memory.runtime as { resourceReservationsOwnerVersion?: number }).resourceReservationsOwnerVersion;
    // key 与 entry 平铺字段不一致（外部篡改信号）。
    seedLegacyEntry("W0N0:energy:mismatch", { roomName: "W1N57", resource: "energy", holderId: "mismatch", amount: 100, updatedAt: 1, expiresAt: Game.time + 100 });
    const report: ReservationOwnerMigrationReport = migrateResourceReservationsForTypedOwner();
    expect(report.failure).toContain("不一致");
    expect((Memory.runtime as { resourceReservationsOwnerVersion?: number }).resourceReservationsOwnerVersion).toBeUndefined();
  });
});

describe("保守占用与 owner-aware 聚合", () => {
  function seedMixedStore(): void {
    const store = Memory.runtime!.resourceReservations!;
    store["W1N57:energy:ow2:lu:0:carrier-legacy"] = { roomName: "W1N57", resource: "energy", holderId: "carrier-legacy", amount: 100, updatedAt: 1, expiresAt: Game.time + 100, owner: { kind: "legacy-unresolved", id: "carrier-legacy" } };
    store[`W1N57:energy:ow2:go:0:${GO_FACTORY}`] = { roomName: "W1N57", resource: "energy", holderId: GO_FACTORY, amount: 200, updatedAt: 1, expiresAt: Game.time + 100, owner: { kind: "game-object", id: GO_FACTORY } };
    store[`W1N57:energy:ow2:go:0:${GO_OTHER}`] = { roomName: "W1N57", resource: "energy", holderId: GO_OTHER, amount: 400, updatedAt: 1, expiresAt: Game.time + 100, owner: { kind: "game-object", id: GO_OTHER } };
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
    Memory.runtime!.resourceReservations![`W1N57:energy:ow2:go:0:${GO_OTHER}`]!.expiresAt = Game.time - 1;
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
    const asLogical = getReservedProductionAmountExcludingOwner("W1N57", "energy", {
      kind: "logical-service", id: GO_FACTORY, namespace: "nuker",
    });
    expect(asLogical).toBe(700);
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
    Memory.runtime!.resourceReservations![`W1N57:G:ow2:ls:5:nuker${NUKE_LOGICAL}`] = {
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
