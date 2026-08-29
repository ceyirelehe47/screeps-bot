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
import { getRuntimeServices, getTreasuryService, registerRuntimeServices } from "@/runtime/runtimeServices";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { formatTreasuryTransactionId } from "@/runtime/treasury/transactionId";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import { installRooms, type RoomSpec } from "@mock/treasury";

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
  resolveHolderRoom?: (holderId: string) => string | undefined;
}): TreasuryService {
  const rooms = installRooms(options?.rooms ?? ROOM_SPECS);
  return createTreasuryService({
    getRooms: () => Object.values(rooms),
    ...(options?.tasks !== undefined ? { getTasks: () => options.tasks! } : {}),
    ...(options?.reservations !== undefined ? { getReservations: () => options.reservations! } : {}),
    ...(options?.holderExists !== undefined ? { holderExists: options.holderExists } : {}),
    ...(options?.resolveHolderRoom !== undefined ? { resolveHolderRoom: options.resolveHolderRoom } : {}),
  });
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
    const result = treasury.recordAcceptedTransaction({
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
    const result = treasury.recordAcceptedTransaction({
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
    expect(treasury.recordAcceptedTransaction({
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
    expect(treasury.recordAcceptedTransaction({
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
      expect(treasury.recordAcceptedTransaction({
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
    "r1": { roomName: "W1N57", resource: RESOURCE_ENERGY, holderId: "holder-A", amount: 3_000, expiresAt: 9_999 },
    "r2": { roomName: "W1N57", resource: RESOURCE_ENERGY, holderId: "holder-B", amount: 2_000, expiresAt: 9_999 },
  });
  /** holder 归属表：A/B 归属 W1N57，C 归属 E5N59。 */
  const holderRooms = (holderId: string): string | undefined =>
    holderId === "holder-A" || holderId === "holder-B" ? "W1N57" : holderId === "holder-C" ? "E5N59" : undefined;
  const ownerDeps = {
    reservations: reservations(),
    holderExists: () => true,
    resolveHolderRoom: holderRooms,
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
      owner: { holderId: "holder-A", scope: "production-reservation", roomName: "W1N57" },
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
      owner: { holderId: "holder-ZZ", scope: "production-reservation", roomName: "W1N57" },
    });
    expect(missing.ownerStatus).toBe("invalid_fail_closed");
    expect(missing.spendable).toBe(0);
    expect(missing.overcommitted).toBe(true);
    expect(missing.observed).toBe(170_000); // observed 物理事实仍如实返回

    const wrongRoom = treasury.query({
      resource: RESOURCE_ENERGY,
      owner: { holderId: "holder-A", scope: "production-reservation", roomName: "E5N59" },
    });
    expect(wrongRoom.ownerStatus).toBe("invalid_fail_closed");

    const noRoom = treasury.query({
      resource: RESOURCE_ENERGY,
      owner: { holderId: "holder-A", scope: "production-reservation", roomName: "" },
    });
    expect(noRoom.ownerStatus).toBe("invalid_fail_closed");

    const emptyHolder = treasury.query({
      resource: RESOURCE_ENERGY,
      owner: { holderId: "", scope: "production-reservation", roomName: "W1N57" },
    });
    expect(emptyHolder.ownerStatus).toBe("invalid_fail_closed");

    const wrongScope = treasury.query({
      resource: RESOURCE_ENERGY,
      owner: { holderId: "holder-A", scope: "market-order" as never, roomName: "W1N57" },
    });
    expect(wrongScope.ownerStatus).toBe("invalid_fail_closed");
  });

  it("owner 查询多房间：只在其合法归属房间排除自己，其他房间不能排除", () => {
    const treasury = makeService({
      reservations: {
        "r1": { roomName: "W1N57", resource: RESOURCE_ENERGY, holderId: "holder-A", amount: 1_000, expiresAt: 9_999 },
        "r2": { roomName: "E5N59", resource: RESOURCE_ENERGY, holderId: "holder-A", amount: 500, expiresAt: 9_999 },
        "r3": { roomName: "E5N59", resource: RESOURCE_ENERGY, holderId: "holder-C", amount: 700, expiresAt: 9_999 },
      },
      holderExists: () => true,
      resolveHolderRoom: holderRooms,
    });
    treasury.beginTick();
    const view = treasury.query({
      resource: RESOURCE_ENERGY,
      owner: { holderId: "holder-A", scope: "production-reservation", roomName: "W1N57" },
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
        "r1": { roomName: "E5N59", resource: RESOURCE_ENERGY, holderId: "holder-C", amount: 700, expiresAt: 9_999 },
      },
      holderExists: () => true,
      resolveHolderRoom: holderRooms,
    });
    treasury.beginTick();
    const view = treasury.query({
      resource: RESOURCE_ENERGY,
      owner: { holderId: "holder-A", scope: "production-reservation", roomName: "W1N57" },
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
    const recorded = services.treasury.recordAcceptedTransaction({
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
    treasury.recordAcceptedTransaction({
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
