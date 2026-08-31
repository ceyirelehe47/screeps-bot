/**
 * Treasury Core 单元测试（observation + facade query + owner + 服务挂载）：
 * - 稀疏枚举正确性与确定性操作计数（storeEnumerations/resourceKeys/
 *   roomFindCalls=0/fallbackLiveReads=0）；
 * - Observed 不可变（冻结数据写入抛错）、同 tick 引用复用、tick 切换重建；
 * - 帝国总量 = Σ位置桶；missing 位置 exists=false；
 * - fresh scope 与 shared 缓存隔离；
 * - 带上下文查询（observed/projected/committed/spendable/overcommitted/
 *   withhold/incoming/locations 过滤）；spendable 非负；
 * - owner-aware：自身预留排除、其他 owner 保留、无 owner 保守、非法 fail closed；
 * - projected capacity 与 observed capacity 分离；
 * - RuntimeServices 挂载与 resetForTest（journal/overlay/heap 幂等缓存全清）。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { compatRecordAcceptedTransaction } from "@/runtime/treasury/compat";
import { getRuntimeServices, getTreasuryService, registerRuntimeServices } from "@/runtime/runtimeServices";
import {
  clearTreasuryPersistenceForTest,
  encodeReceiptKey,
  TREASURY_RECEIPT_MAX_ENTRIES,
  TREASURY_RECEIPT_RETENTION_TICKS,
} from "@/runtime/treasury/receipts";
import { resolveTreasuryHolder } from "@/runtime/treasury/holderResolution";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { formatTreasuryTransactionId } from "@/runtime/treasury/transactionId";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import { installRooms, type RoomSpec } from "@mock/treasury";
import type { TreasuryHolderResolution, TreasuryTransactionInput } from "@/runtime/treasury/types";
import { treasuryTestService, type TreasuryTestService } from "@/runtime/treasury/testHarness";

type RuntimeGlobal = typeof global & { __runtimeServices?: unknown };
function clearRuntimeServicesForTest(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

interface ReservationSeed {
  roomName: string;
  resource: string;
  holderId: string;
  amount: number;
  expiresAt: number;
}

const ROOM_SPECS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 100_000, U: 2_000 } },
    terminal: { id: "term-1", resources: { energy: 20_000, U: 500 } },
  },
  {
    name: "E5N59",
    storage: { id: "stor-2", resources: { energy: 50_000 } },
    terminal: null,
  },
  { name: "E6N59", storage: null, terminal: null },
];

function makeService(options?: {
  rooms?: RoomSpec[];
  tasks?: Record<string, ResourceTransferTask>;
  reservations?: Record<string, ReservationSeed>;
  holderExists?: (holderId: string) => boolean;
  resolveHolder?: (holderId: string) => TreasuryHolderResolution | undefined;
}): TreasuryTestService {
  const rooms = installRooms(options?.rooms ?? ROOM_SPECS);
  return treasuryTestService(createTreasuryService({
    getRooms: () => Object.values(rooms),
    ...(options?.tasks !== undefined ? { getTasks: () => options.tasks! } : {}),
    ...(options?.reservations !== undefined ? { getReservations: () => options.reservations! } : {}),
    ...(options?.holderExists !== undefined ? { holderExists: options.holderExists } : {}),
    ...(options?.resolveHolder !== undefined ? { resolveHolder: options.resolveHolder } : {}),
  }));
}

function pendingTask(overrides: Partial<ResourceTransferTask> & { id: string }): ResourceTransferTask {
  return {
    resource: RESOURCE_ENERGY,
    fromRoomName: "W1N57",
    toRoomName: "E5N59",
    amount: 1_000,
    remainingAmount: 800,
    status: "pending",
    createdAt: 1,
    updatedAt: 1,
    origin: "manual",
    lastProgressAt: 1,
    ...overrides,
  } as ResourceTransferTask;
}

function decisionOf(service: TreasuryService): { scope: "shared" | "market-fresh"; epochSeq: number; observedAtTick: number } {
  const epoch = service.observation().epoch;
  return { scope: epoch.scope, epochSeq: epoch.epochSeq, observedAtTick: epoch.observedAtTick };
}

beforeEach(() => {
  clearRuntimeServicesForTest();
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
});

describe("Treasury observation 物理事实", () => {
  it("稀疏枚举每房间 storage/terminal 数值并保留缺失位置", () => {
    const treasury = makeService();
    treasury.beginTick();
    const observation = treasury.observation();
    expect(observation.amount("W1N57", "storage", RESOURCE_ENERGY)).toBe(100_000);
    expect(observation.amount("W1N57", "storage", "U")).toBe(2_000);
    expect(observation.amount("W1N57", "terminal", RESOURCE_ENERGY)).toBe(20_000);
    expect(observation.amount("E5N59", "storage", RESOURCE_ENERGY)).toBe(50_000);
    expect(observation.locationExists("E5N59", "terminal")).toBe(false);
    expect(observation.location("E6N59", "storage").exists).toBe(false);
    expect(observation.location("W1N57", "storage").structureId).toBe("stor-1");

    const metrics = treasury.metrics();
    // 3 房间 × 2 位置，只对存在的 Store 计数枚举（missing 无枚举成本）。
    expect(metrics.storeEnumerations).toBe(3);
    // 非零 key：stor-1(2) + term-1(2) + stor-2(1) = 5。
    expect(metrics.resourceKeysEnumerated).toBe(5);
    expect(metrics.roomFindCalls).toBe(0);
    expect(metrics.fallbackLiveReads).toBe(0);
  });

  it("帝国总量等于全部位置桶之和且资源并集正确", () => {
    const treasury = makeService();
    treasury.beginTick();
    const observation = treasury.observation();
    expect(observation.empireTotal(RESOURCE_ENERGY)).toBe(170_000);
    expect(observation.empireTotal("U")).toBe(2_500);
    expect([...observation.empireResources()].sort()).toEqual(["U", "energy"]);
    expect(observation.roomAmount("W1N57", "U")).toBe(2_500);
    expect(observation.roomResources("E6N59")).toEqual([]);
  });

  it("Observed 数据不可变（写入冻结字段抛错）且同 tick 引用复用", () => {
    const treasury = makeService();
    treasury.beginTick();
    const first = treasury.observation();
    expect(treasury.observation()).toBe(first);
    expect(() => {
      (first.data.rooms[0] as unknown as { storage: { amounts: Record<string, number> } }).storage.amounts[RESOURCE_ENERGY] = 1;
    }).toThrow();
    expect(treasury.metrics().observationReuseHits).toBeGreaterThan(0);
  });

  it("tick 切换重建 observation 且 epoch 单调递增", () => {
    const treasury = makeService();
    treasury.beginTick();
    const first = treasury.observation();
    treasury.endTick();
    Game.time += 1;
    treasury.beginTick();
    const second = treasury.observation();
    expect(second).not.toBe(first);
    expect(second.epoch.epochSeq).toBeGreaterThan(first.epoch.epochSeq);
    expect(second.epoch.observedAtTick).toBe(Game.time);
  });

  it("fresh observation 独立构建且不污染 shared 缓存", () => {
    const treasury = makeService();
    treasury.beginTick();
    const shared = treasury.observation();
    const fresh = treasury.beginFreshObservation();
    expect(fresh.epoch.scope).toBe("market-fresh");
    expect(fresh.epoch.epochSeq).not.toBe(shared.epoch.epochSeq);
    expect(treasury.observation()).toBe(shared);
    expect(treasury.metrics().freshObservationBuilds).toBe(1);
  });
});

describe("Treasury 带上下文查询", () => {
  it("query 聚合 observed/projected/committed/spendable 并按 locations/rooms 过滤", () => {
    const treasury = makeService({
      tasks: { "t1": pendingTask({ id: "t1", fromRoomName: "W1N57", toRoomName: "E5N59", remainingAmount: 800 }) },
    });
    treasury.beginTick();
    const view = treasury.query({ resource: RESOURCE_ENERGY });
    expect(view.observed).toBe(170_000);
    expect(view.committed).toBe(800);
    expect(view.spendable).toBe(120_000 + 50_000 - 800);

    const storageOnly = treasury.query({ resource: RESOURCE_ENERGY, locations: ["storage"] });
    expect(storageOnly.observed).toBe(150_000);
    expect(storageOnly.committed).toBe(800);

    const singleRoom = treasury.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(singleRoom.observed).toBe(120_000);
    expect(singleRoom.spendable).toBe(120_000 - 800);
  });

  it("withhold 策略保留与 allowIncoming 计入入站", () => {
    const treasury = makeService({
      tasks: { "t1": pendingTask({ id: "t1", fromRoomName: "W1N57", toRoomName: "E5N59", remainingAmount: 800 }) },
    });
    treasury.beginTick();
    const withheld = treasury.query({ resource: RESOURCE_ENERGY, withhold: 10_000 });
    expect(withheld.spendable).toBe(170_000 - 800 - 10_000);

    const withIncoming = treasury.query({ resource: RESOURCE_ENERGY, allowIncoming: true, subtractOutgoing: false, rooms: ["E5N59"] });
    expect(withIncoming.incoming).toBe(800);
    expect(withIncoming.spendable).toBe(50_000 + 800);
  });

  it("projected 查询叠加 transaction delta 而不修改 observed", () => {
    const treasury = makeService();
    treasury.beginTick();
    const decision = decisionOf(treasury);
    const result = compatRecordAcceptedTransaction(treasury, {
      transactionId: formatTreasuryTransactionId("transfer", "stor-1", "term-1"),
      kind: "terminal.send",
      source: "test",
      decision,
      postings: [
        { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -5_000 },
        { roomName: "W1N57", locationKind: "terminal", resource: RESOURCE_ENERGY, delta: 5_000 },
      ],
    });
    expect(result.status).toBe("recorded");

    const terminalView = treasury.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"], locations: ["terminal"] });
    expect(terminalView.observed).toBe(20_000);
    expect(terminalView.projected).toBe(25_000);
    const storageView = treasury.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"], locations: ["storage"] });
    expect(storageView.projected).toBe(95_000);

    // observed 物理事实不变（Observed 不可变）。
    expect(treasury.observation().amount("W1N57", "storage", RESOURCE_ENERGY)).toBe(100_000);
  });

  it("projected capacity 随 posting 推进且与 observed capacity 分离", () => {
    const treasury = makeService({
      rooms: [
        {
          name: "W1N57",
          storage: { id: "stor-1", resources: { energy: 100_000 }, freeCapacity: 10_000 },
          terminal: { id: "term-1", resources: { energy: 20_000, U: 500 }, freeCapacity: 30_000 },
        },
      ],
    });
    treasury.beginTick();
    expect(treasury.observation().usedCapacity("W1N57", "storage")).toBe(100_000);
    expect(treasury.observation().freeCapacity("W1N57", "storage")).toBe(10_000);
    expect(treasury.projectedUsedCapacity("W1N57", "storage")).toBe(100_000);
    expect(treasury.projectedFreeCapacity("W1N57", "storage")).toBe(10_000);

    const decision = decisionOf(treasury);
    const result = compatRecordAcceptedTransaction(treasury, {
      transactionId: formatTreasuryTransactionId("send", 1),
      kind: "terminal.send",
      source: "test",
      decision,
      postings: [
        { roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -4_000 },
        { roomName: "W1N57", locationKind: "terminal", resource: RESOURCE_ENERGY, delta: 4_000 },
      ],
    });
    expect(result.status).toBe("recorded");

    // 流出位置 used 降 free 升；流入位置反向；terminal 多资源聚合正确。
    expect(treasury.projectedUsedCapacity("W1N57", "storage")).toBe(96_000);
    expect(treasury.projectedFreeCapacity("W1N57", "storage")).toBe(14_000);
    expect(treasury.projectedUsedCapacity("W1N57", "terminal")).toBe(24_500);
    expect(treasury.projectedFreeCapacity("W1N57", "terminal")).toBe(26_000);
    // observed 口径不受影响。
    expect(treasury.observation().usedCapacity("W1N57", "storage")).toBe(100_000);
    expect(treasury.observation().freeCapacity("W1N57", "terminal")).toBe(30_000);
  });
});

describe("Treasury 查询输入 fail-closed 规范化", () => {
  it("非法资源返回保守全零视图并计数可审计", () => {
    const treasury = makeService();
    treasury.beginTick();
    const view = treasury.query({ resource: "NOT_A_RESOURCE" as never });
    expect(view.contextStatus).toBe("invalid_fail_closed");
    expect(view.observed).toBe(0);
    expect(view.spendable).toBe(0);
    expect(view.overcommitted).toBe(true);
    expect(view.epoch.scope).toBe("shared"); // epoch 本身仍如实返回
    expect(treasury.metrics().queryInvalidContexts).toBe(1);
  });

  it("重复房间/重复位置拒绝（静默去重会造成双倍累计）", () => {
    const treasury = makeService();
    treasury.beginTick();
    const duplicateRooms = treasury.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57", "W1N57"] });
    expect(duplicateRooms.contextStatus).toBe("invalid_fail_closed");
    expect(duplicateRooms.observed).toBe(0);

    const duplicateLocations = treasury.query({ resource: RESOURCE_ENERGY, locations: ["storage", "storage"] });
    expect(duplicateLocations.contextStatus).toBe("invalid_fail_closed");

    const badRoomName = treasury.query({ resource: RESOURCE_ENERGY, rooms: ["", 42 as never] });
    expect(badRoomName.contextStatus).toBe("invalid_fail_closed");
    expect(treasury.metrics().queryInvalidContexts).toBe(3);
  });

  it("NaN / Infinity / 负数 withhold 拒绝；合法输入标记 valid", () => {
    const treasury = makeService();
    treasury.beginTick();
    for (const withhold of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const view = treasury.query({ resource: RESOURCE_ENERGY, withhold });
      expect(view.contextStatus).toBe("invalid_fail_closed");
      expect(view.spendable).toBe(0);
    }
    const valid = treasury.query({ resource: RESOURCE_ENERGY, withhold: 1_000 });
    expect(valid.contextStatus).toBe("valid");
    expect(valid.spendable).toBe(170_000 - 1_000);
  });
});

describe("Treasury receiver projected headroom 实时性", () => {
  it("同 tick transaction 结算后 projected headroom 立即减少（observed 口径不变、索引不重建）", () => {
    const treasury = makeService({
      rooms: [
        {
          name: "W1N57",
          storage: { id: "stor-1", resources: { energy: 100_000 }, freeCapacity: 200_000 },
          terminal: { id: "term-1", resources: { energy: 20_000 }, freeCapacity: 100_000 },
        },
      ],
    });
    treasury.beginTick();
    const index = treasury.commitments();
    const before = index.receiverCommitments("W1N57");
    expect(before.storageFreeCapacity).toBe(200_000);
    expect(before.projectedStorageHeadroom).toBe(200_000);

    // 结算一笔流入 receiver storage 的 transaction。
    const decision = decisionOf(treasury);
    expect(compatRecordAcceptedTransaction(treasury, {
      transactionId: formatTreasuryTransactionId("incoming", 1),
      kind: "terminal.send",
      source: "test",
      decision,
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: 30_000 }],
    }).status).toBe("recorded");

    // 同一 index 实例（commitment revision 未变不重建），但 projected headroom
    // 必须立即反映最新 overlay——不得返回旧缓存的 projected 数值。
    expect(treasury.commitments()).toBe(index);
    expect(treasury.metrics().commitmentRebuilds).toBe(1);
    const after = index.receiverCommitments("W1N57");
    expect(after.projectedStorageHeadroom).toBe(170_000);
    expect(after.storageFreeCapacity).toBe(200_000); // observed 不变
    expect(after.storageHeadroom).toBe(200_000); // observed 口径 headroom 不变

    // 流出后 projected headroom 恢复。
    expect(compatRecordAcceptedTransaction(treasury, {
      transactionId: formatTreasuryTransactionId("incoming", 2),
      kind: "terminal.send",
      source: "test",
      decision,
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -30_000 }],
    }).status).toBe("recorded");
    expect(index.receiverCommitments("W1N57").projectedStorageHeadroom).toBe(200_000);
  });

  it("多笔、多资源 transaction 对同一位置容量正确聚合", () => {
    const treasury = makeService({
      rooms: [
        {
          name: "W1N57",
          storage: { id: "stor-1", resources: { energy: 100_000, U: 1_000 }, freeCapacity: 100_000 },
          terminal: null,
        },
      ],
    });
    treasury.beginTick();
    const decision = decisionOf(treasury);
    const index = treasury.commitments();
    for (const [resource, delta] of [[RESOURCE_ENERGY, 10_000], ["U", 5_000], [RESOURCE_ENERGY, 7_000]] as const) {
      expect(compatRecordAcceptedTransaction(treasury, {
        transactionId: formatTreasuryTransactionId("multi", resource, delta),
        kind: "terminal.send",
        source: "test",
        decision,
        postings: [{ roomName: "W1N57", locationKind: "storage", resource, delta }],
      }).status).toBe("recorded");
    }
    // 10_000 + 5_000 + 7_000 = 22_000 跨资源聚合到同一位置。
    expect(index.receiverCommitments("W1N57").projectedStorageHeadroom).toBe(78_000);
    expect(treasury.projectedUsedCapacity("W1N57", "storage")).toBe(123_000);
  });
});

describe("Treasury owner-aware 查询（holder 存在性 + 房间归属验证）", () => {
  const reservations = (): Record<string, ReservationSeed> => ({
    "r1": { roomName: "W1N57", resource: RESOURCE_ENERGY, holderId: "aa1b2c3d4e5f6a7b8c9d0e1f", amount: 3_000, expiresAt: 9_999 },
    "r2": { roomName: "W1N57", resource: RESOURCE_ENERGY, holderId: "bb2c3d4e5f6a7b8c9d0e1f2a", amount: 2_000, expiresAt: 9_999 },
  });
  /** holder 归属表：A/B 归属 W1N57，C 归属 E5N59（模拟 game-object holder）。 */
  const holderRooms = (holderId: string): TreasuryHolderResolution | undefined => {
    if (holderId === "aa1b2c3d4e5f6a7b8c9d0e1f" || holderId === "bb2c3d4e5f6a7b8c9d0e1f2a") return { kind: "game-object", roomName: "W1N57" };
    if (holderId === "cc3d4e5f6a7b8c9d0e1f2a1b") return { kind: "game-object", roomName: "E5N59" };
    return undefined;
  };
  const ownerDeps = {
    reservations: reservations(),
    holderExists: () => true,
    resolveHolder: holderRooms,
  };

  it("无 owner 时保守扣除全部活跃 reservation", () => {
    const treasury = makeService(ownerDeps);
    treasury.beginTick();
    const view = treasury.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.ownerStatus).toBe("none");
    expect(view.contextStatus).toBe("valid");
    expect(view.committed).toBe(5_000);
  });

  it("合法 owner 只在自己归属房间排除自己的 reservation，其他 owner 照常扣除", () => {
    const treasury = makeService(ownerDeps);
    treasury.beginTick();
    const view = treasury.query({
      resource: RESOURCE_ENERGY,
      rooms: ["W1N57"],
      owner: { ownerKind: "game-object", ownerId: "aa1b2c3d4e5f6a7b8c9d0e1f", scope: "production-reservation", roomName: "W1N57" },
    });
    expect(view.ownerStatus).toBe("excluded-own-reservations");
    expect(view.committed).toBe(2_000);
    expect(view.spendable).toBe(120_000 - 2_000);
  });

  it("holder 不存在 / 声明房间与真实归属不一致 / 格式非法 一律 fail closed", () => {
    const treasury = makeService(ownerDeps);
    treasury.beginTick();
    const missing = treasury.query({
      resource: RESOURCE_ENERGY,
      owner: { ownerKind: "game-object", ownerId: "zz9e5f6a7b8c9d0e1f2a1b2c", scope: "production-reservation", roomName: "W1N57" },
    });
    expect(missing.ownerStatus).toBe("invalid_fail_closed");
    expect(missing.spendable).toBe(0);
    expect(missing.overcommitted).toBe(true);
    expect(missing.observed).toBe(170_000); // observed 物理事实仍如实返回

    const wrongRoom = treasury.query({
      resource: RESOURCE_ENERGY,
      owner: { ownerKind: "game-object", ownerId: "aa1b2c3d4e5f6a7b8c9d0e1f", scope: "production-reservation", roomName: "E5N59" },
    });
    expect(wrongRoom.ownerStatus).toBe("invalid_fail_closed");

    const noRoom = treasury.query({
      resource: RESOURCE_ENERGY,
      owner: { ownerKind: "game-object", ownerId: "aa1b2c3d4e5f6a7b8c9d0e1f", scope: "production-reservation", roomName: "" },
    });
    expect(noRoom.ownerStatus).toBe("invalid_fail_closed");

    const emptyHolder = treasury.query({
      resource: RESOURCE_ENERGY,
      owner: { ownerKind: "game-object", ownerId: "", scope: "production-reservation", roomName: "W1N57" },
    });
    expect(emptyHolder.ownerStatus).toBe("invalid_fail_closed");

    const wrongScope = treasury.query({
      resource: RESOURCE_ENERGY,
      owner: { ownerKind: "game-object", ownerId: "aa1b2c3d4e5f6a7b8c9d0e1f", scope: "market-order" as never, roomName: "W1N57" },
    });
    expect(wrongScope.ownerStatus).toBe("invalid_fail_closed");
  });

  it("owner 查询多房间：只在其合法归属房间排除自己，其他房间不能排除", () => {
    const treasury = makeService({
      reservations: {
        "r1": { roomName: "W1N57", resource: RESOURCE_ENERGY, holderId: "aa1b2c3d4e5f6a7b8c9d0e1f", amount: 1_000, expiresAt: 9_999 },
        "r2": { roomName: "E5N59", resource: RESOURCE_ENERGY, holderId: "aa1b2c3d4e5f6a7b8c9d0e1f", amount: 500, expiresAt: 9_999 },
        "r3": { roomName: "E5N59", resource: RESOURCE_ENERGY, holderId: "cc3d4e5f6a7b8c9d0e1f2a1b", amount: 700, expiresAt: 9_999 },
      },
      holderExists: () => true,
      resolveHolder: holderRooms,
    });
    treasury.beginTick();
    const view = treasury.query({
      resource: RESOURCE_ENERGY,
      owner: { ownerKind: "game-object", ownerId: "aa1b2c3d4e5f6a7b8c9d0e1f", scope: "production-reservation", roomName: "W1N57" },
    });
    expect(view.ownerStatus).toBe("excluded-own-reservations");
    // W1N57 的 r1（A 本人）被排除；E5N59 不是 A 的归属房间——r2（也是 A 的）
    // 与 r3 照常扣除：500 + 700。
    expect(view.committed).toBe(1_200);
    expect(view.spendable).toBe(170_000 - 1_200);
  });

  it("owner 没有对应 reservation 时查询正常返回且不排除其他记录", () => {
    const treasury = makeService({
      reservations: {
        "r1": { roomName: "E5N59", resource: RESOURCE_ENERGY, holderId: "cc3d4e5f6a7b8c9d0e1f2a1b", amount: 700, expiresAt: 9_999 },
      },
      holderExists: () => true,
      resolveHolder: holderRooms,
    });
    treasury.beginTick();
    const view = treasury.query({
      resource: RESOURCE_ENERGY,
      owner: { ownerKind: "game-object", ownerId: "aa1b2c3d4e5f6a7b8c9d0e1f", scope: "production-reservation", roomName: "W1N57" },
    });
    expect(view.ownerStatus).toBe("excluded-own-reservations");
    expect(view.committed).toBe(700);
    expect(view.contextStatus).toBe("valid");
  });
});

describe("RuntimeServices 集成", () => {
  it("treasury 服务经 runtimeServices 挂载并可 resetForTest 清空投影状态", () => {
    installRooms([{ name: "W1N57", storage: { id: "stor-1", resources: { energy: 1_000 } }, terminal: null }]);
    registerRuntimeServices();
    const services = getRuntimeServices();
    services.treasury.beginTick();
    const decision = decisionOf(services.treasury);
    const recorded = compatRecordAcceptedTransaction(treasuryTestService(services.treasury), {
      transactionId: formatTreasuryTransactionId("send", "x"),
      kind: "terminal.send",
      source: "test",
      decision,
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -100 }],
    });
    expect(recorded.status).toBe("recorded");
    expect(services.treasury.journal()).toHaveLength(1);

    services.treasury.resetForTest();
    expect(services.treasury.journal()).toHaveLength(0);
    const metrics = services.treasury.metrics();
    expect(metrics.transactionsRecorded).toBe(0);
    expect(metrics.postingsRecorded).toBe(0);
    // reset 后服务仍可正常重建。
    services.treasury.beginTick();
    expect(services.treasury.observation().amount("W1N57", "storage", RESOURCE_ENERGY)).toBe(1_000);
    expect(getTreasuryService()).toBe(services.treasury);
  });

  it("resetForTest 后 overlay 消失（测试隔离契约）", () => {
    const treasury = makeService({
      rooms: [{ name: "W1N57", storage: { id: "stor-1", resources: { energy: 1_000 } }, terminal: null }],
    });
    treasury.beginTick();
    const decision = decisionOf(treasury);
    compatRecordAcceptedTransaction(treasury, {
      transactionId: formatTreasuryTransactionId("send", "dup"),
      kind: "send",
      source: "test",
      decision,
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: -100 }],
    });
    expect(treasury.projectedUsedCapacity("W1N57", "storage")).toBe(900);
    treasury.resetForTest();
    treasury.beginTick();
    expect(treasury.projectedUsedCapacity("W1N57", "storage")).toBe(1_000);
  });
});

describe("Treasury 两阶段 prepare/commit/abort 协议", () => {
  const TX_ID = "stable:send:W1N57:1";

  function twoPhaseInput(
    treasury: TreasuryTestService,
    transactionId: string,
    delta = -500,
  ): TreasuryTransactionInput {
    return {
      transactionId,
      kind: "terminal.send",
      source: "test",
      decision: decisionOf(treasury),
      postings: [{ roomName: "W1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta }],
    };
  }

  function prepareOk(treasury: TreasuryTestService, input: TreasuryTransactionInput) {
    const prepared = treasury.prepareTransaction(input);
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") throw new Error("prepare 失败");
    return prepared.handle;
  }

  it("prepare→commit 成功兑现：journal/overlay/receipt 全部生效，tentative 转 committed", () => {
    const treasury = makeService();
    treasury.beginTick();
    const prepared = treasury.prepareTransaction(twoPhaseInput(treasury, TX_ID));
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") throw new Error("prepare 失败");
    const handle = prepared.handle;
    expect(prepared.preparedAtTick).toBe(Game.time);
    // prepare 本身零 committed 状态（无 journal/无投影），tentative 已预留。
    expect(treasury.journal()).toHaveLength(0);
    expect(treasury.projectedUsedCapacity("W1N57", "storage")).toBe(102_000);
    expect(treasury.metrics().tentativeCapacityKeys).toBe(1);

    const committed = treasury.commitPreparedTransaction(handle);
    expect(committed.status).toBe("committed");
    expect(treasury.journal()).toHaveLength(1);
    expect(treasury.projectedUsedCapacity("W1N57", "storage")).toBe(101_500);
    // commit 后 tentative 清零。
    expect(treasury.metrics().tentativeCapacityKeys).toBe(0);
    // 重复 commit 幂等 already_settled。
    expect(treasury.commitPreparedTransaction(handle).status).toBe("already_settled");
  });

  it("abort 零状态释放：无 journal/无投影/无 receipt，同 id 可重新 prepare", () => {
    const treasury = makeService();
    treasury.beginTick();
    const handle = prepareOk(treasury, twoPhaseInput(treasury, TX_ID));
    expect(treasury.abortPreparedTransaction(handle).status).toBe("aborted");
    expect(treasury.journal()).toHaveLength(0);
    expect(treasury.projectedUsedCapacity("W1N57", "storage")).toBe(102_000);
    expect(treasury.metrics().tentativeCapacityKeys).toBe(0);
    expect(treasury.metrics().transactionPreparesAborted).toBe(1);
    // abort 后同 id 重新 prepare→commit 成功（id 未被 receipt 占用）。
    const rehandle = prepareOk(treasury, twoPhaseInput(treasury, TX_ID));
    expect(treasury.commitPreparedTransaction(rehandle).status).toBe("committed");
  });

  it("abort 后 commit 拒绝（handle_finalized）；重复 abort 幂等 already_finalized", () => {
    const treasury = makeService();
    treasury.beginTick();
    const handle = prepareOk(treasury, twoPhaseInput(treasury, TX_ID));
    expect(treasury.abortPreparedTransaction(handle).status).toBe("aborted");
    const committed = treasury.commitPreparedTransaction(handle);
    expect(committed.status).toBe("rejected");
    if (committed.status === "rejected") expect(committed.reason).toBe("handle_finalized");
    const reabort = treasury.abortPreparedTransaction(handle);
    expect(reabort.status).toBe("already_finalized");
    if (reabort.status === "already_finalized") expect(reabort.finalizedAs).toBe("aborted");
    expect(treasury.journal()).toHaveLength(0);
  });

  it("commit 后 abort 不改变结果（already_finalized finalizedAs=committed）", () => {
    const treasury = makeService();
    treasury.beginTick();
    const handle = prepareOk(treasury, twoPhaseInput(treasury, TX_ID));
    expect(treasury.commitPreparedTransaction(handle).status).toBe("committed");
    const aborted = treasury.abortPreparedTransaction(handle);
    expect(aborted.status).toBe("already_finalized");
    if (aborted.status === "already_finalized" && aborted.finalizedAs === "committed") {
      expect(aborted.committedAtTick).toBe(Game.time);
    }
    // 结算事实不受 abort 影响。
    expect(treasury.journal()).toHaveLength(1);
  });

  it("prepare 预留容量槽：此后他人填满 store，commit 兑现仍不被容量拒绝", () => {
    // seed MAX-2 条 receipt → prepare 占 1 槽 → 单阶段填满最后槽位 → commit 仍成功。
    Memory.runtime = Memory.runtime ?? {};
    const settled: Record<string, number> = {};
    for (let i = 0; i < TREASURY_RECEIPT_MAX_ENTRIES - 2; i += 1) {
      settled[encodeReceiptKey(`seed:${i}`)] = Game.time;
    }
    Memory.runtime.treasury = {
      receipts: {
        version: 3 as unknown as 5,
        settled,
        updatedAt: Game.time,
        entryCount: TREASURY_RECEIPT_MAX_ENTRIES - 2,
        nextExpiryTick: Game.time + TREASURY_RECEIPT_RETENTION_TICKS + 1,
      },
    };
    const treasury = makeService();
    treasury.beginTick();
    const handle = prepareOk(treasury, twoPhaseInput(treasury, TX_ID));
    // 单阶段登记挤占最后一个槽位（admission 计入 pending 预留后仍剩 1）。
    expect(
      compatRecordAcceptedTransaction(treasury, twoPhaseInput(treasury, formatTreasuryTransactionId("fill", "1"))).status,
    ).toBe("recorded");
    // store 已满；prepared 槽位已预留——commit 兑现不因容量被拒。
    expect(treasury.commitPreparedTransaction(handle).status).toBe("committed");
  });

  it("tentative 预留使他人无法抢占：drain 在其自身 admission 被拒，commit 仍 committed", () => {
    const treasury = makeService();
    treasury.beginTick();
    const handle = prepareOk(treasury, twoPhaseInput(treasury, TX_ID, -90_000));
    // 他人单阶段尝试把同一 storage energy 再流出 95_000：授权计算计入
    // tentative（100_000-90_000 剩 10_000 < 95_000）→ prepare 预留不被抢占。
    const drain = compatRecordAcceptedTransaction(treasury, 
      twoPhaseInput(treasury, formatTreasuryTransactionId("drain", "1"), -95_000),
    );
    expect(drain.status).toBe("rejected");
    // 拒绝即可证明 tentative 隔离（该房间无垫底资源，流出超量同时触发
    // used 非负与资源非负两类物理校验，先命中 capacity_overflow）。
    if (drain.status === "rejected") {
      expect(["insufficient_amount", "capacity_overflow"]).toContain(drain.reason);
    }
    expect(treasury.journal()).toHaveLength(0);
    // Game API 已 OK 的 prepared handle：commit 兑现不再因业务条件被拒
    // （prepare_invalidated 正常路径已删除）。
    expect(treasury.commitPreparedTransaction(handle).status).toBe("committed");
    expect(treasury.journal()).toHaveLength(1);
  });

  it("跨 tick prepared handle 失效（handle_expired），须重新 prepare", () => {
    const treasury = makeService();
    treasury.beginTick();
    const handle = prepareOk(treasury, twoPhaseInput(treasury, TX_ID));
    Game.time += 1;
    treasury.beginTick();
    const result = treasury.commitPreparedTransaction(handle);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBe("handle_expired");
  });

  it("跨 tick 未 beginTick 时旧 handle 仍自行拒绝（不依赖调用方先 beginTick）", () => {
    const treasury = makeService();
    treasury.beginTick();
    const handle = prepareOk(treasury, twoPhaseInput(treasury, TX_ID));
    Game.time += 1;
    // 不调用 beginTick，直接 commit/abort 旧 handle：tick 自校验拒绝。
    const committed = treasury.commitPreparedTransaction(handle);
    expect(committed.status).toBe("rejected");
    if (committed.status === "rejected") expect(committed.reason).toBe("handle_expired");
    const aborted = treasury.abortPreparedTransaction(handle);
    expect(aborted.status).toBe("rejected");
    if (aborted.status === "rejected") expect(aborted.reason).toBe("handle_expired");
  });

  it("endTick 后 prepare 拒绝 tick_closed、未决 handle 全部作废", () => {
    const treasury = makeService();
    treasury.beginTick();
    const handle = prepareOk(treasury, twoPhaseInput(treasury, TX_ID));
    treasury.endTick();
    const after = treasury.prepareTransaction(twoPhaseInput(treasury, "stable:send:W1N57:2"));
    expect(after.status).toBe("rejected");
    if (after.status === "rejected") expect(after.reason).toBe("tick_closed");
    // tick 边界作废：既有 handle 不可 commit/abort。
    const committed = treasury.commitPreparedTransaction(handle);
    expect(committed.status).toBe("rejected");
    if (committed.status === "rejected") expect(committed.reason).toBe("handle_expired");
    const aborted = treasury.abortPreparedTransaction(handle);
    expect(aborted.status).toBe("rejected");
    if (aborted.status === "rejected") expect(aborted.reason).toBe("handle_expired");
  });

  it("相同 ID、相同 payload 幂等返回同一 handle；不同 payload 返回 prepare_conflict", () => {
    const treasury = makeService();
    treasury.beginTick();
    const first = treasury.prepareTransaction(twoPhaseInput(treasury, TX_ID));
    const second = treasury.prepareTransaction(twoPhaseInput(treasury, TX_ID));
    expect(first.status).toBe("prepared");
    expect(second.status).toBe("prepared");
    if (first.status === "prepared" && second.status === "prepared") {
      expect(second.handle).toBe(first.handle); // 同一对象（幂等）
      expect(second.preparedAtTick).toBe(first.preparedAtTick);
      expect(second.digest).toBe(first.digest);
    }
    expect(treasury.metrics().transactionsPrepared).toBe(1);
    // 不同 payload（delta 不同 → digest 不同）→ prepare_conflict。
    const conflict = treasury.prepareTransaction(twoPhaseInput(treasury, TX_ID, -600));
    expect(conflict.status).toBe("rejected");
    if (conflict.status === "rejected") expect(conflict.reason).toBe("prepare_conflict");
    expect(treasury.metrics().prepareConflicts).toBe(1);
  });

  it("prepare 后修改原 input 不影响 canonical payload（digest 与后续 commit）", () => {
    const treasury = makeService();
    treasury.beginTick();
    const input = twoPhaseInput(treasury, TX_ID);
    const handle = prepareOk(treasury, input);
    // 调用方原地篡改原 postings/kind——Treasury 内部 canonical 不受影响。
    (input.postings[0] as { delta: number }).delta = -999_999;
    (input as { kind: string }).kind = "mutated";
    // 相同业务输入（重新构造同 payload）仍幂等命中同一 handle。
    const again = treasury.prepareTransaction(twoPhaseInput(treasury, TX_ID));
    expect(again.status).toBe("prepared");
    if (again.status === "prepared") expect(again.handle).toBe(handle);
    // commit 兑现的是 prepare 时的 canonical（-500），不是被篡改的 -999_999。
    expect(treasury.commitPreparedTransaction(handle).status).toBe("committed");
    expect(treasury.projectedUsedCapacity("W1N57", "storage")).toBe(101_500);
  });
});

describe("Treasury typed owner 与 logical holder 解析", () => {
  function logicalDeps() {
    return {
      reservations: {
        "r1": { roomName: "W1N57", resource: RESOURCE_ENERGY, holderId: "nuker:nk1:G", amount: 3_000, expiresAt: 9_999 },
        "r2": { roomName: "W1N57", resource: RESOURCE_ENERGY, holderId: "bb2c3d4e5f6a7b8c9d0e1f2a", amount: 2_000, expiresAt: 9_999 },
      } as Record<string, ReservationSeed>,
      holderExists: () => true,
      resolveHolder: (holderId: string): TreasuryHolderResolution | undefined =>
        holderId === "nuker:nk1:G"
          ? { kind: "logical", roomName: "W1N57" }
          : holderId === "bb2c3d4e5f6a7b8c9d0e1f2a"
            ? { kind: "game-object", roomName: "W1N57" }
            : undefined,
    };
  }

  it("logical holder（nuker 逻辑名）合法排除自己预留，不再被误判降级", () => {
    const treasury = makeService(logicalDeps());
    treasury.beginTick();
    const view = treasury.query({
      resource: RESOURCE_ENERGY,
      rooms: ["W1N57"],
      owner: { ownerKind: "logical-service", ownerId: "nuker:nk1:G", namespace: "nuker", scope: "production-reservation", roomName: "W1N57" },
    });
    expect(view.ownerStatus).toBe("excluded-own-reservations");
    expect(view.committed).toBe(2_000);
  });

  it("声明 holderKind 与运行时解析类型不一致 fail closed（不得冒充其他类型 owner）", () => {
    const treasury = makeService(logicalDeps());
    treasury.beginTick();
    const view = treasury.query({
      resource: RESOURCE_ENERGY,
      rooms: ["W1N57"],
      owner: { ownerKind: "game-object", ownerId: "nuker:nk1:G", scope: "production-reservation", roomName: "W1N57" },
    });
    expect(view.ownerStatus).toBe("invalid_fail_closed");
    expect(view.spendable).toBe(0);
    expect(view.overcommitted).toBe(true);
  });

  it("resolveTreasuryHolder 默认解析：nuker/synthesis 命名空间与裸 object id", () => {
    installRooms(ROOM_SPECS);
    const originalGetObjectById = Game.getObjectById;
    Game.getObjectById = ((id: string) => (id === "nk1" ? { room: { name: "W1N57" } } : null)) as never;
    try {
      expect(resolveTreasuryHolder("nuker:nk1:G")).toEqual({ kind: "logical", roomName: "W1N57" });
      expect(resolveTreasuryHolder("synthesis:W1N57:energy")).toEqual({ kind: "logical", roomName: "W1N57" });
      expect(resolveTreasuryHolder("nk1")).toEqual({ kind: "game-object", roomName: "W1N57" });
      // 无法确证存在：未知对象 / 非 owned 房间 / 空 id。
      expect(resolveTreasuryHolder("nuker:gone:G")).toBeUndefined();
      expect(resolveTreasuryHolder("synthesis:Z9Z9:energy")).toBeUndefined();
      expect(resolveTreasuryHolder("")).toBeUndefined();
    } finally {
      Game.getObjectById = originalGetObjectById;
    }
  });
});

describe("Treasury 查询输入 fail-closed 补全（unknown room / 空 scope / 非法布尔）", () => {
  it("非管辖房间（unknown/unowned）拒绝，不给跨管辖乐观可用量", () => {
    const treasury = makeService();
    treasury.beginTick();
    const view = treasury.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57", "Z9Z9"] });
    expect(view.contextStatus).toBe("invalid_fail_closed");
    expect(view.spendable).toBe(0);
    expect(view.overcommitted).toBe(true);
    expect(treasury.metrics().queryInvalidContexts).toBe(1);
  });

  it("空 rooms / 空 locations scope 拒绝（不给合法零集错觉）", () => {
    const treasury = makeService();
    treasury.beginTick();
    expect(treasury.query({ resource: RESOURCE_ENERGY, rooms: [] }).contextStatus).toBe("invalid_fail_closed");
    expect(treasury.query({ resource: RESOURCE_ENERGY, locations: [] }).contextStatus).toBe("invalid_fail_closed");
    expect(treasury.metrics().queryInvalidContexts).toBe(2);
  });

  it("非布尔开关字段拒绝（0/'true' 等真值不得静默当 true）", () => {
    const treasury = makeService();
    treasury.beginTick();
    expect(
      treasury.query({ resource: RESOURCE_ENERGY, allowProjected: 1 as unknown as boolean }).contextStatus,
    ).toBe("invalid_fail_closed");
    expect(
      treasury.query({ resource: RESOURCE_ENERGY, subtractReservations: "true" as unknown as boolean }).contextStatus,
    ).toBe("invalid_fail_closed");
    // 合法布尔与缺省不受影响。
    expect(treasury.query({ resource: RESOURCE_ENERGY, allowIncoming: true }).contextStatus).toBe("valid");
    expect(treasury.query({ resource: RESOURCE_ENERGY }).contextStatus).toBe("valid");
  });
});

