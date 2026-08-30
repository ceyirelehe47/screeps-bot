/**
 * Treasury commitment 数据验证与 completeness 测试（第五轮）：
 * - 记录级验证：负 amount 不进 committed（不得提高 spendable）、NaN/
 *   remaining>amount/非法资源/非法房间等损坏记录不进聚合、不删原数据；
 * - scope 标记：能定位 (room,resource) 的损坏 → incomplete-scope（其他
 *   scope 保持 complete）；连 scope 都无法定位 → globally-incomplete；
 * - 授权语义：incomplete scope 的 spendable=0、authorizationSafe=false、
 *   overcommitted=true；commitment 查询零 Memory/Game 写入；
 * - 保守扣除：owner unresolved 但数值合法的 reservation 继续全额扣除
 *   （completeness 不因 owner 缺失而受损——missing ≠ 不完整）；
 * - 第六轮补严：status/blockedReason 枚举（未知值是损坏而非普通非
 *   pending）、resource 必须在官方 catalog（非法资源 → global incomplete）、
 *   聚合累加安全整数（溢出 → scope incomplete）；
 * - 第六轮 authorizationSafe 联合判定：write fault / quarantine unresolved /
 *   receipt unhealthy / lifecycle closed / migration incomplete 均令
 *   authorizationSafe=false 且 authorizationBlockers 指出主因（数值保留）。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { buildTreasuryCommitmentIndex } from "@/runtime/treasury/commitments";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { installRooms, type RoomSpec } from "@mock/treasury";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import { recordTreasuryWriteFault } from "@/runtime/treasury/writeFault";
import { quarantineTreasuryTransaction } from "@/runtime/treasury/quarantine";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";

const ROOMS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 100_000, U: 2_000 }, freeCapacity: 10_000 },
    terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 5_000 },
  },
  {
    name: "E5N59",
    storage: { id: "stor-2", resources: { energy: 50_000 }, freeCapacity: 10_000 },
    terminal: { id: "term-2", resources: { energy: 0 }, freeCapacity: 5_000 },
  },
];

function makeService(options?: {
  tasks?: Record<string, ResourceTransferTask>;
  reservations?: Record<string, unknown>;
}): TreasuryTestService {
  const rooms = installRooms(ROOMS);
  return treasuryTestService(createTreasuryService({
    getRooms: () => Object.values(rooms),
    ...(options?.tasks !== undefined ? { getTasks: () => options.tasks! } : {}),
    ...(options?.reservations !== undefined
      ? { getReservations: () => options.reservations as never }
      : {}),
  }));
}

function makeTask(overrides: Partial<ResourceTransferTask> & { id: string }): ResourceTransferTask {
  return {
    resource: RESOURCE_ENERGY,
    fromRoomName: "W1N57",
    toRoomName: "E5N59",
    amount: 1_000_000,
    remainingAmount: 1_000,
    status: "pending",
    createdAt: 900,
    updatedAt: 1000,
    origin: "manual",
    lastProgressAt: 1000,
    ...overrides,
  } as ResourceTransferTask;
}

function res(holderId: string, amount: number, resource: ResourceConstant = RESOURCE_ENERGY, roomName = "W1N57") {
  return { roomName, resource, holderId, amount, expiresAt: Game.time + 500 };
}

beforeEach(() => {
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
});

describe("commitment 记录级验证", () => {
  it("负 amount 预留不进 committed（不得提高 spendable），scope 标记 incomplete", () => {
    const service = makeService({
      reservations: {
        "bad": res("holder-bad", -5_000),
        "ok": res("holder-ok", 2_000),
      },
    });
    service.beginTick();
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    // 损坏记录所在 scope 不可授权：spendable=0、authorizationSafe=false。
    expect(view.spendable).toBe(0);
    expect(view.authorizationSafe).toBe(false);
    expect(view.commitmentStatus).toBe("incomplete-scope");
    expect(view.overcommitted).toBe(true);
    const metrics = service.metrics();
    expect(metrics.invalidCommitmentRecords).toBe(1);
    expect(metrics.incompleteCommitmentScopes).toBe(1);
  });

  it("NaN amount 预留使相应 scope incomplete（不污染聚合求和）", () => {
    const service = makeService({
      reservations: {
        "nan": res("holder-nan", Number.NaN),
      },
    });
    service.beginTick();
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(Number.isNaN(view.committed)).toBe(false); // NaN 不进聚合
    expect(view.commitmentStatus).toBe("incomplete-scope");
    expect(view.spendable).toBe(0);
  });

  it("invalid task remainingAmount（remaining > amount）使双侧 scope incomplete", () => {
    const service = makeService({
      tasks: {
        "bad": makeTask({ id: "bad", remainingAmount: 2_000, amount: 1_000 }),
      },
    });
    service.beginTick();
    const donor = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(donor.commitmentStatus).toBe("incomplete-scope");
    expect(donor.authorizationSafe).toBe(false);
    const receiver = service.query({ resource: RESOURCE_ENERGY, rooms: ["E5N59"] });
    expect(receiver.commitmentStatus).toBe("incomplete-scope");
  });

  it("非法资源/房间的 task 不被静默忽略：scope 无法定位 → globally-incomplete", () => {
    const service = makeService({
      tasks: {
        "garbage": { id: "garbage" } as ResourceTransferTask,
      },
    });
    service.beginTick();
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.commitmentStatus).toBe("globally-incomplete");
    expect(view.spendable).toBe(0);
    expect(view.authorizationSafe).toBe(false);
  });

  it("损坏记录原样保留（读取路径零删除）且 commitment 查询零写入", () => {
    const tasks = { "bad": makeTask({ id: "bad", remainingAmount: 2_000, amount: 1_000 }) };
    const service = makeService({ tasks });
    service.beginTick();
    const before = JSON.stringify({ tasks, reservations: {} });
    service.commitments();
    service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(JSON.stringify({ tasks, reservations: {} })).toBe(before);
  });
});

describe("completeness 状态与保守扣除", () => {
  it("unrelated scope 仍保持 complete（损坏只污染可定位的 bucket）", () => {
    const service = makeService({
      reservations: {
        // U 资源维度损坏，energy 维度不受影响。
        "bad-u": res("holder-bad", -1, "U"),
      },
    });
    service.beginTick();
    const energy = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(energy.commitmentStatus).toBe("complete");
    expect(energy.authorizationSafe).toBe(true);
    const uranium = service.query({ resource: "U", rooms: ["W1N57"] });
    expect(uranium.commitmentStatus).toBe("incomplete-scope");
    // 其他房间同资源也不受影响（scope 是 (room,resource) 粒度）。
    const otherRoom = service.query({ resource: "U", rooms: ["E5N59"] });
    expect(otherRoom.commitmentStatus).toBe("complete");
  });

  it("owner unresolved 但数值合法：继续全额保守扣除且 completeness 保持 complete", () => {
    const service = makeService({
      reservations: {
        "missing-owner": res("carrier-gone", 3_000),
      },
    });
    service.beginTick();
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.committed).toBe(3_000); // 保守扣除
    expect(view.commitmentStatus).toBe("complete"); // missing ≠ 不完整
    expect(view.authorizationSafe).toBe(true);
    expect(service.metrics().missingOwnerStillCommitted).toBe(1);
  });

  it("索引 completeness API：snapshot 与逐 scope 查询一致", () => {
    const service = makeService({
      reservations: { "bad": res("holder-bad", -5) },
    });
    service.beginTick();
    const commitments = service.commitments();
    expect(commitments.completeness.complete).toBe(false);
    expect(commitments.completeness.invalidRecords).toBe(1);
    expect(commitments.commitmentCompleteness("W1N57", RESOURCE_ENERGY)).toBe("incomplete-scope");
    expect(commitments.commitmentCompleteness("E5N59", RESOURCE_ENERGY)).toBe("complete");
    expect(commitments.receiverCommitments("W1N57").commitmentComplete).toBe(false);
    expect(commitments.receiverCommitments("E5N59").commitmentComplete).toBe(true);
  });
});

describe("第六轮补严：枚举与聚合溢出", () => {
  it("未知 task status（pendng）是损坏而非普通非 pending：双侧 scope incomplete", () => {
    const service = makeService({
      tasks: { "typo": makeTask({ id: "typo", status: "pendng" as never }) },
    });
    service.beginTick();
    const donor = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(donor.commitmentStatus).toBe("incomplete-scope");
    expect(donor.authorizationSafe).toBe(false);
    expect(service.metrics().invalidCommitmentRecords).toBe(1);
  });

  it("枚举外 blockedReason 是损坏（不是未阻塞）：scope incomplete", () => {
    const service = makeService({
      tasks: { "bad-reason": makeTask({ id: "bad-reason", blockedReason: "bogus" as never }) },
    });
    service.beginTick();
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.commitmentStatus).toBe("incomplete-scope");
    expect(view.authorizationSafe).toBe(false);
  });

  it("task 非法 resource（不在官方 catalog）：无法定位 scope → globally-incomplete", () => {
    const service = makeService({
      tasks: { "bad-res": makeTask({ id: "bad-res", resource: "unobtainium" as never }) },
    });
    service.beginTick();
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.commitmentStatus).toBe("globally-incomplete");
    expect(view.authorizationSafe).toBe(false);
    expect(view.spendable).toBe(0);
  });

  it("聚合溢出安全整数：多条合法 remainingAmount 相加溢出 → scope incomplete", () => {
    const huge = makeTask({ id: "huge-a", remainingAmount: Number.MAX_SAFE_INTEGER - 1, amount: Number.MAX_SAFE_INTEGER });
    const huge2 = makeTask({ id: "huge-b", remainingAmount: Number.MAX_SAFE_INTEGER - 1, amount: Number.MAX_SAFE_INTEGER });
    const service = makeService({ tasks: { "huge-a": huge, "huge-b": huge2 } });
    service.beginTick();
    const donor = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(donor.commitmentStatus).toBe("incomplete-scope");
    expect(donor.authorizationSafe).toBe(false);
    expect(Number.isFinite(donor.committed)).toBe(true); // 聚合值未溢出为不安全数
  });

  it("reservation 聚合溢出：同 scope 多条相加溢出 → scope incomplete", () => {
    const service = makeService({
      reservations: {
        "r1": res("holder-huge-a", Number.MAX_SAFE_INTEGER - 1),
        "r2": res("holder-huge-b", Number.MAX_SAFE_INTEGER - 1),
      },
    });
    service.beginTick();
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.commitmentStatus).toBe("incomplete-scope");
    expect(view.authorizationSafe).toBe(false);
    expect(Number.isFinite(view.committed)).toBe(true);
  });
});

describe("第六轮 authorizationSafe 联合判定与 blockers", () => {
  it("clean/healthy：authorizationSafe=true 且无 blockers", () => {
    const service = makeService();
    service.beginTick();
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.authorizationSafe).toBe(true);
    expect(view.authorizationBlockers).toEqual([]);
  });

  it("write fault：authorizationSafe=false，blockers 指示，数值保留", () => {
    const service = makeService();
    service.beginTick();
    recordTreasuryWriteFault({
      transactionId: "ts1_blocker", digest: "0000000000000000", tick: Game.time,
      kind: "test", source: "test", phase: "receipt_publish", status: "unresolved", recordedAt: Game.time,
    });
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.authorizationSafe).toBe(false);
    expect(view.authorizationBlockers).toContain("write_fault");
    expect(view.observed).toBe(120_000); // 数值保留供观察（不以归零掩盖原因）
    expect(view.projected).toBe(120_000);
  });

  it("quarantine unresolved：authorizationSafe=false 且 blockers 指示", () => {
    const service = makeService();
    service.beginTick();
    quarantineTreasuryTransaction({
      transactionId: "ts1_q_blocker", digest: "0000000000000000", tick: Game.time,
      kind: "test", source: "test", phase: "executing_at_end_tick",
      outcome: "started_unknown",
      settlement: "quarantined",
      deltas: [], recordedAt: Game.time,
    });
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.authorizationSafe).toBe(false);
    expect(view.authorizationBlockers).toContain("quarantine_unresolved");
    expect(view.observed).toBe(120_000);
  });

  it("receipt unhealthy（未知版本 fail closed）：authorizationSafe=false", () => {
    const service = makeService();
    service.beginTick();
    // 写入未知版本 store 并失效 heap 缓存（下一次 load 校验 fatal）。
    Memory.runtime!.treasury!.receipts = {
      version: 99, settled: {}, updatedAt: Game.time, entryCount: 0, nextExpiryTick: null,
    } as never;
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.authorizationSafe).toBe(false);
    expect(view.authorizationBlockers).toContain("receipt_unhealthy");
  });

  it("lifecycle closed（endTick 后）：authorizationSafe=false", () => {
    const service = makeService();
    service.beginTick();
    service.endTick();
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.authorizationSafe).toBe(false);
    expect(view.authorizationBlockers).toContain("lifecycle_closed");
    expect(view.observed).toBe(120_000); // 观察数值仍可用
  });

  it("reservation migration 失败（malformed entry 阻断激活）：authorizationSafe=false，修复后恢复", () => {
    // 第七轮：beginTick 的 schema activation gate 会自动迁移 legacy store
    // （version 缺失 + 数据合法 → 成功激活）——migration blocker 只在迁移
    // 失败（malformed entry / 未知版本）时持续。构造 malformed entry 使
    // gate 失败：原数据不动、授权 fail closed。
    Memory.runtime = Memory.runtime ?? {};
    Memory.runtime.resourceReservations = {
      "W1N57:energy:legacy-holder": {
        roomName: "W1N57", resource: RESOURCE_ENERGY, holderId: "legacy-holder",
        amount: -100, updatedAt: 1, expiresAt: Game.time + 500, // 负 amount：malformed
      },
    } as never;
    const service = makeService();
    service.beginTick();
    const view = service.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.authorizationSafe).toBe(false);
    expect(view.authorizationBlockers).toContain("reservation_migration_incomplete");
    // writeAdmission 同口径阻断（schema 未激活）。
    expect(view.writeAdmission.ready).toBe(false);
    expect(service.metrics().reservationSchemaActivationFailures).toBeGreaterThan(0);
    // 修复数据后恢复（迁移成功 + commitment 重建）。
    Memory.runtime!.resourceReservations = {};
    const migrated = makeService();
    migrated.beginTick();
    expect(migrated.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] }).authorizationSafe).toBe(true);
  });
});
