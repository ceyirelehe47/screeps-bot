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
}): TreasuryService {
  const rooms = installRooms(options?.rooms ?? ROOM_SPECS);
  return createTreasuryService({
    getRooms: () => Object.values(rooms),
    ...(options?.tasks !== undefined ? { getTasks: () => options.tasks! } : {}),
    ...(options?.reservations !== undefined ? { getReservations: () => options.reservations! } : {}),
    ...(options?.holderExists !== undefined ? { holderExists: options.holderExists } : {}),
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

describe("Treasury owner-aware 查询", () => {
  const reservations = (): Record<string, ReservationSeed> => ({
    "holder-A": { roomName: "W1N57", resource: RESOURCE_ENERGY, holderId: "holder-A", amount: 3_000, expiresAt: 9_999 },
    "holder-B": { roomName: "W1N57", resource: RESOURCE_ENERGY, holderId: "holder-B", amount: 2_000, expiresAt: 9_999 },
  });

  it("无 owner 时保守扣除全部活跃 reservation", () => {
    const treasury = makeService({ reservations: reservations(), holderExists: () => true });
    treasury.beginTick();
    const view = treasury.query({ resource: RESOURCE_ENERGY, rooms: ["W1N57"] });
    expect(view.ownerStatus).toBe("none");
    expect(view.committed).toBe(5_000);
  });

  it("owner 查询自身时只排除自己的 reservation，其他 owner 照常扣除", () => {
    const treasury = makeService({ reservations: reservations(), holderExists: () => true });
    treasury.beginTick();
    const view = treasury.query({
      resource: RESOURCE_ENERGY,
      rooms: ["W1N57"],
      owner: { holderId: "holder-A", scope: "production-reservation" },
    });
    expect(view.ownerStatus).toBe("excluded-own-reservations");
    expect(view.committed).toBe(2_000);
    expect(view.spendable).toBe(120_000 - 2_000);
  });

  it("owner 非法（空 holderId / 未知 scope）时 fail closed", () => {
    const treasury = makeService({ reservations: reservations(), holderExists: () => true });
    treasury.beginTick();
    const emptyHolder = treasury.query({
      resource: RESOURCE_ENERGY,
      owner: { holderId: "", scope: "production-reservation" },
    });
    expect(emptyHolder.ownerStatus).toBe("invalid_fail_closed");
    expect(emptyHolder.spendable).toBe(0);
    expect(emptyHolder.overcommitted).toBe(true);
    // observed 物理事实仍如实返回，只是不给乐观可用量。
    expect(emptyHolder.observed).toBe(170_000);

    const wrongScope = treasury.query({
      resource: RESOURCE_ENERGY,
      owner: { holderId: "holder-A", scope: "market-order" as never },
    });
    expect(wrongScope.ownerStatus).toBe("invalid_fail_closed");
    expect(wrongScope.spendable).toBe(0);
  });

  it("owner-aware 语义作用于多房间/多资源作用域", () => {
    const treasury = makeService({
      reservations: {
        "r1": { roomName: "W1N57", resource: RESOURCE_ENERGY, holderId: "holder-A", amount: 1_000, expiresAt: 9_999 },
        "r2": { roomName: "E5N59", resource: RESOURCE_ENERGY, holderId: "holder-A", amount: 500, expiresAt: 9_999 },
        "r3": { roomName: "W1N57", resource: "U", holderId: "holder-B", amount: 200, expiresAt: 9_999 },
      },
      holderExists: () => true,
    });
    treasury.beginTick();
    const energy = treasury.query({
      resource: RESOURCE_ENERGY,
      owner: { holderId: "holder-A", scope: "production-reservation" },
    });
    expect(energy.committed).toBe(0);
    const mineral = treasury.query({
      resource: "U",
      owner: { holderId: "holder-A", scope: "production-reservation" },
    });
    expect(mineral.committed).toBe(200);
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
