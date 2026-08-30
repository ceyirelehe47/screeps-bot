/**
 * resourceReservation mutation 权威测试（第七轮）：
 * - 既有语义回归：TTL 自定义、按 holder 定向 release；
 * - 结构化结果：reserve/renew/release 全验证矩阵（roomName 形状 / resource
 *   ∈ RESOURCES_ALL / amount 正安全整数 / ttl 正安全整数 / expiresAt 溢出 /
 *   owner kind-specific / schema gate），非法输入零写入、零 bump；
 * - revision 只在实际 mutation 时增加一次（no-op release/renew 不 bump；
 *   deprecated adapter 不二次 bump）；
 * - GC：expired 删除 + bump、malformed 不删除并置持久 corrupted 标志
 *   （mutation/授权 fail closed），显式 repair 解除。
 */
import {
  gcProductionReservations,
  listProductionReservations,
  releaseProductionReservation,
  releaseProductionReservationForOwner,
  renewProductionReservationForOwner,
  repairReservationStoreCorruptionForRepair,
  reserveProductionResource,
  reserveProductionResourceForOwner,
  ensureReservationSchemaActivated,
  isReservationStoreCorrupted,
} from "@/runtime/resourceReservation";
import { readTreasuryCommitmentRevision, resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";

const GO_FACTORY = "a1b2c3d4e5f6a7b8c9d0e1f2";

beforeEach(() => {
  Memory.runtime = {};
  Game.time = 1000;
  resetTreasuryCommitmentRevisionForTest();
});

describe("resourceReservation", () => {
  describe("reserveProductionResource", () => {
    it("uses custom TTL when provided", () => {
      const result = reserveProductionResource("E4N58", "energy" as ResourceConstant, 500, "carrier1", 50);
      expect(result).toEqual({ status: "ok", mutated: true });
      const entries = listProductionReservations();
      expect(entries[0].expiresAt).toBe(Game.time + 50);
    });
  });

  describe("releaseProductionReservation", () => {
    it("removes a specific holder reservation", () => {
      reserveProductionResource("E4N58", "energy" as ResourceConstant, 500, "carrier1");
      reserveProductionResource("E4N58", "energy" as ResourceConstant, 300, "carrier2");
      releaseProductionReservation("E4N58", "energy" as ResourceConstant, "carrier1");
      const entries = listProductionReservations();
      expect(entries).toHaveLength(1);
      expect(entries[0].holderId).toBe("carrier2");
    });
  });
});

describe("第七轮：mutation 结构化验证矩阵（非法输入零写入零 bump）", () => {
  it.each([
    ["NaN amount", { amount: Number.NaN }, "invalid_amount"],
    ["Infinity amount", { amount: Number.POSITIVE_INFINITY }, "invalid_amount"],
    ["零 amount", { amount: 0 }, "invalid_amount"],
    ["负 amount", { amount: -100 }, "invalid_amount"],
    ["非整数 amount", { amount: 10.5 }, "invalid_amount"],
  ])("reserve %s：结构化拒绝且 store 为空", (_label, overrides, reason) => {
    const result = reserveProductionResourceForOwner(
      "E4N58",
      "energy" as ResourceConstant,
      (overrides as { amount: number }).amount,
      { kind: "game-object", id: GO_FACTORY },
    );
    expect(result.status).toBe("rejected");
    expect((result as { reason: string }).reason).toBe(reason);
    expect(listProductionReservations()).toHaveLength(0);
    expect(readTreasuryCommitmentRevision()).toBe(0);
  });

  it.each([
    ["非法资源", "unobtainium" as ResourceConstant, "invalid_resource"],
    ["空资源", "" as ResourceConstant, "invalid_resource"],
  ])("reserve %s：结构化拒绝", (_label, resource, reason) => {
    const result = reserveProductionResourceForOwner("E4N58", resource, 100, { kind: "game-object", id: GO_FACTORY });
    expect(result.status).toBe("rejected");
    expect((result as { reason: string }).reason).toBe(reason);
  });

  it.each([
    ["非法房间名（非房间形状）", "not-a-room", "invalid_room"],
    ["空房间名", "", "invalid_room"],
    ["小写房间名", "w1n1", "invalid_room"],
  ])("reserve %s：结构化拒绝", (_label, roomName, reason) => {
    const result = reserveProductionResourceForOwner(roomName, "energy" as ResourceConstant, 100, { kind: "game-object", id: GO_FACTORY });
    expect(result.status).toBe("rejected");
    expect((result as { reason: string }).reason).toBe(reason);
  });

  it.each([
    ["NaN TTL", Number.NaN, "invalid_ttl"],
    ["Infinity TTL", Number.POSITIVE_INFINITY, "invalid_ttl"],
    ["零 TTL", 0, "invalid_ttl"],
    ["负 TTL", -5, "invalid_ttl"],
  ])("reserve %s：结构化拒绝", (_label, ttl, reason) => {
    const result = reserveProductionResourceForOwner("E4N58", "energy" as ResourceConstant, 100, { kind: "game-object", id: GO_FACTORY }, ttl);
    expect(result.status).toBe("rejected");
    expect((result as { reason: string }).reason).toBe(reason);
  });

  it("expiresAt 溢出安全整数：结构化拒绝（Game.time + ttl 不溢出保证）", () => {
    const hugeTtl = Number.MAX_SAFE_INTEGER;
    const result = reserveProductionResourceForOwner("E4N58", "energy" as ResourceConstant, 100, { kind: "game-object", id: GO_FACTORY }, hugeTtl);
    expect(result.status).toBe("rejected");
    expect((result as { reason: string }).reason).toBe("expiry_overflow");
    expect(listProductionReservations()).toHaveLength(0);
  });

  it("owner kind-specific 违规：结构化拒绝（logical-service 缺 namespace / 非 ls 带 namespace）", () => {
    expect(
      reserveProductionResourceForOwner("E4N58", "energy" as ResourceConstant, 100, { kind: "logical-service", id: "nuker:x" }),
    ).toMatchObject({ status: "rejected", reason: "invalid_owner" });
    expect(
      reserveProductionResourceForOwner("E4N58", "energy" as ResourceConstant, 100, { kind: "task", id: "task:1", namespace: "nuker" } as never),
    ).toMatchObject({ status: "rejected", reason: "invalid_owner" });
  });

  it("deprecated adapter 与 typed 入口行为一致（不二次 bump：一次 reserve 恰好 +1）", () => {
    const before = readTreasuryCommitmentRevision();
    const result = reserveProductionResource("E4N58", "energy" as ResourceConstant, 500, "carrier-legacy");
    expect(result).toEqual({ status: "ok", mutated: true });
    expect(readTreasuryCommitmentRevision()).toBe(before + 1); // 单次 bump
    const releaseResult = releaseProductionReservation("E4N58", "energy" as ResourceConstant, "carrier-legacy");
    expect(releaseResult).toEqual({ status: "ok", mutated: true });
    expect(readTreasuryCommitmentRevision()).toBe(before + 2);
  });
});

describe("第七轮：GC 与 corrupted 标志", () => {
  it("expired 删除并 bump；malformed 不删除、置持久 corrupted 标志、mutation 拒绝、repair 解除", () => {
    reserveProductionResourceForOwner("E4N58", "energy" as ResourceConstant, 500, { kind: "game-object", id: GO_FACTORY }, 50);
    reserveProductionResourceForOwner("E4N58", "energy" as ResourceConstant, 300, { kind: "task", id: "task:1" }, 50);
    // 把 task 预留改为已过期（expiresAt < Game.time）。
    (Memory.runtime!.resourceReservations!["E4N58:energy:ow2:tk:0:task:1"] as { expiresAt: number }).expiresAt = Game.time - 1;
    // 注入 malformed entry（模拟 Memory 损坏）。
    (Memory.runtime!.resourceReservations! as Record<string, unknown>)["E4N58:energy:broken"] = { roomName: "E4N58" };
    const revisionBefore = readTreasuryCommitmentRevision();

    const report = gcProductionReservations();
    expect(report.removed).toBe(1); // task:1 已过期（ttl=1，Game.time 未变则 expiresAt=1001 >= 1000？——见下方时序）
    expect(report.corrupted).toBe(1);
    expect(listProductionReservations()).toHaveLength(2); // GO 保留 + broken 保留（task:1 被删）
    // 实际删除恰好 bump 一次。
    expect(readTreasuryCommitmentRevision()).toBe(revisionBefore + 1);
    // corrupted 标志：持久 fail closed。
    expect(isReservationStoreCorrupted()).toBe(true);
    expect(ensureReservationSchemaActivated()).toMatchObject({ status: "rejected", reason: "store_corrupted" });
    expect(
      renewProductionReservationForOwner("E4N58", "energy" as ResourceConstant, 100, { kind: "game-object", id: GO_FACTORY }, 50),
    ).toMatchObject({ status: "rejected", reason: "schema_not_ready" });
    // 显式 repair：broken entry 仍在 → 拒绝（人工清除后解除）。
    expect(repairReservationStoreCorruptionForRepair().status).toBe("rejected");
    delete Memory.runtime!.resourceReservations!["E4N58:energy:broken"];
    expect(repairReservationStoreCorruptionForRepair().status).toBe("repaired");
    expect(isReservationStoreCorrupted()).toBe(false);
    expect(
      renewProductionReservationForOwner("E4N58", "energy" as ResourceConstant, 100, { kind: "game-object", id: GO_FACTORY }, 50),
    ).toEqual({ status: "ok", mutated: true });
  });
});
