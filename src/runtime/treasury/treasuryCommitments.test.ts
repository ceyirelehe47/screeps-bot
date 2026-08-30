/**
 * Treasury Commitment Index 测试：
 * - transfer task 聚合：outgoing/pendingOutgoing(reasonPrefix)/incoming(demand
 *   覆盖语义：manual 永远计入、automatic 超时排除)/pendingIncoming/taskCount；
 * - route merge lookup 与旧 findMergeablePendingTask 语义一致；
 * - production reservation：活跃聚合、holder 自排除、过期读侧排除（原记录
 *   不删除）、孤儿排除计数；
 * - receiver headroom 与超卖信号（healthyIncoming > free；observed 与
 *   projected 双轨）；
 * - 点时快照：构建后原 task/reservation 对象被修改不影响已构建索引；
 *   receiver 查询不回扫 live task store；
 * - revision invalidation：权威 mutation（bump）后 facade 下次查询重建；
 * - 查询零隐藏写入（Memory 快照前后一致）。
 */
import { buildTreasuryCommitmentIndex } from "@/runtime/treasury/commitments";
import { createTreasuryService } from "@/runtime/treasury/facade";
import { compatRecordAcceptedTransaction } from "@/runtime/treasury/compat";
import { treasuryTestService } from "@/runtime/treasury/testHarness";
import { bumpTreasuryCommitmentRevision, readTreasuryCommitmentRevision, resetTreasuryCommitmentRevisionForTest } from "@/runtime/treasury/commitmentRevision";
import { clearTreasuryPersistenceForTest } from "@/runtime/treasury/receipts";
import { formatTreasuryTransactionId } from "@/runtime/treasury/transactionId";
import { reserveProductionResource } from "@/runtime/resourceReservation";
import type { ResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";

type RuntimeGlobal = typeof global & { __runtimeServices?: unknown };
function clearRuntimeServicesForTest(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

const storePrototype = {
  getUsedCapacity(resource?: ResourceConstant): number {
    if (resource === undefined) {
      let total = 0;
      for (const key of Object.keys(this)) {
        const value = (this as unknown as Record<string, unknown>)[key];
        if (typeof value === "number") total += value;
      }
      return total;
    }
    return ((this as unknown as Record<string, number>)[resource] as number) || 0;
  },
  getFreeCapacity(): number {
    return (this as unknown as { __freeCapacity: number }).__freeCapacity;
  },
} as unknown as StoreDefinition;

function makeStore(resources: Record<string, number>, freeCapacity: number): StoreDefinition {
  const store = Object.create(storePrototype) as StoreDefinition;
  for (const [resource, amount] of Object.entries(resources)) {
    (store as unknown as Record<string, number>)[resource] = amount;
  }
  Object.defineProperty(store, "__freeCapacity", { value: freeCapacity, enumerable: false, writable: true });
  return store;
}

function installEmpire(): void {
  Game.rooms = {
    W1N57: {
      name: "W1N57",
      controller: { my: true, level: 8 },
      storage: { id: "stor-1", store: makeStore({ energy: 300_000 }, 700_000) } as unknown as StructureStorage,
      terminal: { id: "term-1", store: makeStore({ energy: 20_000 }, 280_000) } as unknown as StructureTerminal,
    } as unknown as Room,
    E1N57: {
      name: "E1N57",
      controller: { my: true, level: 8 },
      storage: { id: "stor-2", store: makeStore({ energy: 150_000 }, 850_000) } as unknown as StructureStorage,
      terminal: { id: "term-2", store: makeStore({ energy: 0 }, 300_000) } as unknown as StructureTerminal,
    } as unknown as Room,
  };
}

function makeTask(overrides: Partial<ResourceTransferTask> & { id: string }): ResourceTransferTask {
  return {
    resource: "U",
    fromRoomName: "W1N57",
    toRoomName: "E1N57",
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

beforeEach(() => {
  clearRuntimeServicesForTest();
  Game.time = 3000;
  clearTreasuryPersistenceForTest();
  resetTreasuryCommitmentRevisionForTest();
  installEmpire();
});

describe("transfer task 承诺聚合", () => {
  it("outgoing/pendingOutgoing/reasonPrefix 与 done 任务排除", () => {
    const tasks: Record<string, ResourceTransferTask> = {
      "t1": makeTask({ id: "t1", remainingAmount: 1_000, reason: "hub:import:energy" }),
      "t2": makeTask({ id: "t2", remainingAmount: 2_500, reason: "synthesis:supply" }),
      "t3": makeTask({ id: "t3", remainingAmount: 9_999, status: "done" }),
    };
    const observation = createTreasuryService({ getRooms: () => Object.values(Game.rooms) }).observation();
    const index = buildTreasuryCommitmentIndex({
      tick: Game.time,
      tasks,
      reservations: {},
      observation,
      holderExists: () => true,
    });

    expect(index.outgoing("W1N57", "U")).toBe(3_500);
    expect(index.pendingOutgoing("W1N57", "U")).toBe(3_500);
    expect(index.pendingOutgoing("W1N57", "U", "hub:")).toBe(1_000);
    expect(index.pendingOutgoing("W1N57", "U", "synthesis:")).toBe(2_500);
    expect(index.outgoingTaskCount("W1N57")).toBe(2);
    expect(index.metrics.pendingTaskRecords).toBe(2);
    expect(index.metrics.taskRecords).toBe(3);
  });

  it("incoming 需求覆盖语义：manual 永远计入、automatic 超时排除", () => {
    const tasks: Record<string, ResourceTransferTask> = {
      "manual-1": makeTask({ id: "manual-1", remainingAmount: 700, origin: "manual" }),
      "auto-fresh": makeTask({ id: "auto-fresh", remainingAmount: 300, origin: "automatic", lastProgressAt: 2990 }),
      "auto-stale": makeTask({
        id: "auto-stale",
        remainingAmount: 5_000,
        origin: "automatic",
        lastProgressAt: 1000,
        // Game.time - lastProgressAt = 2000 > default noProgressTtl 5000? 不，
        // 默认 TTL=5000，此处改为构造 source_depleted 超时。
        blockedReason: "source_depleted",
        blockedSince: 2800,
      }),
    };
    const observation = createTreasuryService({ getRooms: () => Object.values(Game.rooms) }).observation();
    const index = buildTreasuryCommitmentIndex({
      tick: Game.time,
      tasks,
      reservations: {},
      observation,
      holderExists: () => true,
    });

    // manual 700 + auto-fresh 300 计入；auto-stale（source_depleted 200 tick
    // 超过 100 tick 宽限）不覆盖需求。
    expect(index.incoming("E1N57", "U")).toBe(1_000);
    expect(index.pendingIncoming("E1N57", "U")).toBe(6_000);
    expect(index.incomingTaskCount("E1N57")).toBe(2);
  });

  it("route merge lookup 匹配 route/origin/reason 且跳过过期 automatic", () => {
    const tasks: Record<string, ResourceTransferTask> = {
      "m1": makeTask({ id: "m1", origin: "manual", reason: "hub:import:U" }),
      "a-stale": makeTask({
        id: "a-stale",
        origin: "automatic",
        reason: "synthesis:U",
        blockedReason: "source_depleted",
        blockedSince: 2800,
      }),
      "a-live": makeTask({ id: "a-live", origin: "automatic", reason: "synthesis:U", lastProgressAt: 2995 }),
    };
    const observation = createTreasuryService({ getRooms: () => Object.values(Game.rooms) }).observation();
    const index = buildTreasuryCommitmentIndex({
      tick: Game.time,
      tasks,
      reservations: {},
      observation,
      holderExists: () => true,
    });

    expect(index.findMergeableTaskId("U", "W1N57", "E1N57", "manual", "hub:import:U")).toBe("m1");
    expect(index.findMergeableTaskId("U", "W1N57", "E1N57", "automatic", "synthesis:U")).toBe("a-live");
    expect(index.findMergeableTaskId("U", "W1N57", "E1N57", "manual", undefined)).toBeNull();
    expect(index.findMergeableTaskId("K", "W1N57", "E1N57", "manual", "hub:import:U")).toBeNull();
  });
});

describe("production reservation 承诺", () => {
  const GO_LAB1 = "a1b2c3d4e5f6a7b8c9d0e1f2";
  const GO_LAB2 = "b2c3d4e5f6a7b8c9d0e1f2a1";
  const GO_GONE = "c3d4e5f6a7b8c9d0e1f2a1b2";
  const GO_EXPIRED = "d4e5f6a7b8c9d0e1f2a1b2c3";

  function makeReservations(): Record<string, { roomName: string; resource: string; holderId: string; amount: number; expiresAt: number }> {
    return {
      "W1N57:U:lab-1": { roomName: "W1N57", resource: "U", holderId: GO_LAB1, amount: 400, expiresAt: 3200 },
      "W1N57:U:lab-2": { roomName: "W1N57", resource: "U", holderId: GO_LAB2, amount: 250, expiresAt: 3200 },
      "W1N57:U:lab-expired": { roomName: "W1N57", resource: "U", holderId: GO_EXPIRED, amount: 999, expiresAt: 2999 },
      "W1N57:K:lab-gone": { roomName: "W1N57", resource: "K", holderId: GO_GONE, amount: 500, expiresAt: 3200 },
    };
  }

  it("活跃聚合、typed owner 自排除、过期排除与 missing-owner 保守计入", () => {
    const observation = createTreasuryService({ getRooms: () => Object.values(Game.rooms) }).observation();
    const index = buildTreasuryCommitmentIndex({
      tick: Game.time,
      tasks: {},
      reservations: makeReservations(),
      observation,
      holderExists: (holderId) => holderId !== GO_GONE,
    });

    expect(index.reservedProduction("W1N57", "U")).toBe(650);
    // typed owner 自排除（完整 identity 比较）。
    expect(index.reservedProduction("W1N57", "U", { kind: "game-object", id: GO_LAB1 })).toBe(250);
    // owner 消失的活跃预留保守计入 committed（不得当作可重新支配）。
    expect(index.reservedProduction("W1N57", "K")).toBe(500);
    expect(index.metrics.reservationRecords).toBe(4);
    expect(index.metrics.activeReservationRecords).toBe(3);
    expect(index.metrics.expiredReservationsExcluded).toBe(1);
    expect(index.metrics.typedOwnerResolved).toBe(2);
    expect(index.metrics.missingOwnerStillCommitted).toBe(1);

    const snapshot = index.reservationSnapshot();
    expect(snapshot.find((entry) => entry.holderId === GO_EXPIRED)?.expired).toBe(true);
    expect(snapshot.find((entry) => entry.holderId === GO_GONE)?.ownerStatus).toBe("active-unresolved");
    expect(snapshot.find((entry) => entry.holderId === GO_LAB1)?.ownerStatus).toBe("active-resolved");
  });

  it("过期预留被排除但原始 Memory 记录不被删除（零隐藏写入）", () => {
    Memory.runtime = {
      resourceReservations: {
        "W1N57:U:lab-1": { roomName: "W1N57", resource: "U", holderId: "lab-1", amount: 400, updatedAt: 2900, expiresAt: 2999 },
      },
    } as unknown as Memory["runtime"];
    const before = JSON.stringify(Memory.runtime);

    const treasury = treasuryTestService(createTreasuryService({
      getRooms: () => Object.values(Game.rooms),
      holderExists: () => true,
    }));
    const commitments = treasury.commitments();
    expect(commitments.reservedProduction("W1N57", "U")).toBe(0);
    expect(commitments.metrics.expiredReservationsExcluded).toBe(1);

    // 全量查询路径零写：任务表与预留表快照不变。
    treasury.query({ resource: "U", rooms: ["W1N57"] });
    expect(JSON.stringify(Memory.runtime)).toBe(before);
  });
});

describe("receiver capacity 承诺", () => {
  it("headroom = free − healthyIncoming 且超卖显式可见", () => {
    const tasks: Record<string, ResourceTransferTask> = {
      "in-1": makeTask({ id: "in-1", toRoomName: "E1N57", remainingAmount: 50_000, origin: "automatic", lastProgressAt: 2999 }),
      "in-blocked": makeTask({
        id: "in-blocked",
        toRoomName: "E1N57",
        remainingAmount: 400_000,
        origin: "automatic",
        lastProgressAt: 2999,
        blockedReason: "receiver_capacity",
        blockedSince: 2995,
      }),
    };
    const observation = createTreasuryService({ getRooms: () => Object.values(Game.rooms) }).observation();
    const index = buildTreasuryCommitmentIndex({
      tick: Game.time,
      tasks,
      reservations: {},
      observation,
      holderExists: () => true,
    });

    const receiver = index.receiverCommitments("E1N57");
    // blocked 任务不算健康承诺；E1N57 storage free=850000。
    expect(receiver.healthyIncomingAmount).toBe(50_000);
    expect(receiver.healthyIncomingTaskCount).toBe(1);
    expect(receiver.storageFreeCapacity).toBe(850_000);
    expect(receiver.storageHeadroom).toBe(800_000);
    expect(receiver.overcommitted).toBe(false);

    // 构造超卖：接收方 free 不足以覆盖健康承诺。
    const tightTasks: Record<string, ResourceTransferTask> = {
      "in-big": makeTask({ id: "in-big", toRoomName: "E1N57", remainingAmount: 900_000, origin: "automatic", lastProgressAt: 2999 }),
    };
    const tightIndex = buildTreasuryCommitmentIndex({
      tick: Game.time,
      tasks: tightTasks,
      reservations: {},
      observation,
      holderExists: () => true,
    });
    const tight = tightIndex.receiverCommitments("E1N57");
    expect(tight.healthyIncomingAmount).toBe(900_000);
    expect(tight.storageHeadroom + tight.terminalHeadroom).toBeLessThan(0);
    expect(tight.overcommitted).toBe(true);
  });

  it("receiver headroom 提供 projected 口径（observed free 扣减本 tick 已结算容量净变化）", () => {
    const tasks: Record<string, ResourceTransferTask> = {
      "in-1": makeTask({ id: "in-1", toRoomName: "E1N57", remainingAmount: 50_000, origin: "automatic", lastProgressAt: 2999 }),
    };
    const treasury = treasuryTestService(createTreasuryService({ getRooms: () => Object.values(Game.rooms) }));
    treasury.beginTick();
    // 本 tick 已结算：E1N57 storage 净流入 30_000（占掉 free）。
    const epoch = treasury.observation().epoch;
    expect(compatRecordAcceptedTransaction(treasury, {
      transactionId: formatTreasuryTransactionId("inflow", 1),
      kind: "terminal.send",
      source: "test",
      decision: { scope: epoch.scope, epochSeq: epoch.epochSeq, observedAtTick: epoch.observedAtTick },
      postings: [{ roomName: "E1N57", locationKind: "storage", resource: RESOURCE_ENERGY, delta: 30_000 }],
    }).status).toBe("recorded");

    const index = buildTreasuryCommitmentIndex({
      tick: Game.time,
      tasks,
      reservations: {},
      observation: treasury.observation(),
      holderExists: () => true,
      capacityDelta: (roomName, kind) =>
        roomName === "E1N57" && kind === "storage" ? 30_000 : 0,
    });
    const receiver = index.receiverCommitments("E1N57");
    // observed：free 850_000 − 50_000 = 800_000。
    expect(receiver.storageHeadroom).toBe(800_000);
    // projected：free 820_000 − 50_000 = 770_000。
    expect(receiver.projectedStorageHeadroom).toBe(770_000);
    expect(receiver.projectedOvercommitted).toBe(false);
  });
});

describe("承诺索引点时快照（primitive 化）", () => {
  it("构建后原 task 对象被修改，旧 snapshot 结果不变", () => {
    const task = makeTask({ id: "t1", remainingAmount: 1_000, reason: "hub:import:U" });
    const tasks: Record<string, ResourceTransferTask> = { "t1": task };
    const observation = createTreasuryService({ getRooms: () => Object.values(Game.rooms) }).observation();
    const index = buildTreasuryCommitmentIndex({
      tick: Game.time,
      tasks,
      reservations: {},
      observation,
      holderExists: () => true,
    });

    // 外部原地修改原对象（模拟绕过 revision 的写法）。
    task.remainingAmount = 9_999;
    task.status = "done";

    expect(index.outgoing("W1N57", "U")).toBe(1_000);
    expect(index.outgoingTaskCount("W1N57")).toBe(1);
    expect(index.findMergeableTaskId("U", "W1N57", "E1N57", "manual", "hub:import:U")).toBe("t1");
  });

  it("route merge 重复 key 时返回第一个匹配（旧 findMergeablePendingTask 语义，不取最后写入）", () => {
    // 同 route/origin/reason 两条 pending 任务：Object.values 插入顺序 t-first 在前。
    const tasks: Record<string, ResourceTransferTask> = {
      "t-first": makeTask({ id: "t-first", remainingAmount: 1_000, reason: "hub:import:U" }),
      "t-second": makeTask({ id: "t-second", remainingAmount: 2_000, reason: "hub:import:U" }),
    };
    const observation = createTreasuryService({ getRooms: () => Object.values(Game.rooms) }).observation();
    const index = buildTreasuryCommitmentIndex({
      tick: Game.time,
      tasks,
      reservations: {},
      observation,
      holderExists: () => true,
    });
    expect(index.findMergeableTaskId("U", "W1N57", "E1N57", "manual", "hub:import:U")).toBe("t-first");
  });

  it("构建后向 live task store 添加新任务，receiverCommitments 不回扫（预聚合）", () => {
    const tasks: Record<string, ResourceTransferTask> = {
      "in-1": makeTask({ id: "in-1", toRoomName: "E1N57", remainingAmount: 50_000, origin: "automatic", lastProgressAt: 2999 }),
    };
    const observation = createTreasuryService({ getRooms: () => Object.values(Game.rooms) }).observation();
    const index = buildTreasuryCommitmentIndex({
      tick: Game.time,
      tasks,
      reservations: {},
      observation,
      holderExists: () => true,
    });

    // 构建后 store 出现新健康入站任务——旧索引不感知（点时快照语义）。
    tasks["in-2"] = makeTask({ id: "in-2", toRoomName: "E1N57", remainingAmount: 123_456, origin: "automatic", lastProgressAt: Game.time });
    const receiver = index.receiverCommitments("E1N57");
    expect(receiver.healthyIncomingAmount).toBe(50_000);
    expect(receiver.healthyIncomingTaskCount).toBe(1);
  });

  it("索引查询不保留可变任务引用：reservationSnapshot 冻结且返回副本", () => {
    const reservations: Record<string, { roomName: string; resource: string; holderId: string; amount: number; expiresAt: number }> = {
      "W1N57:U:lab-1": { roomName: "W1N57", resource: "U", holderId: "lab-1", amount: 400, expiresAt: 3200 },
    };
    const observation = createTreasuryService({ getRooms: () => Object.values(Game.rooms) }).observation();
    const index = buildTreasuryCommitmentIndex({
      tick: Game.time,
      tasks: {},
      reservations,
      observation,
      holderExists: () => true,
    });

    const snapshot = index.reservationSnapshot();
    expect(() => {
      (snapshot as unknown as unknown[]).push({} as never);
    }).toThrow();
    // 原 reservation 修改不影响快照。
    reservations["W1N57:U:lab-1"].amount = 9_999;
    expect(index.reservedProduction("W1N57", "U")).toBe(400);
  });
});

describe("承诺索引 revision invalidation（facade 级）", () => {
  it("mutation bump 后 commitments() 重建并看到新状态；查询仍零写", () => {
    const treasury = treasuryTestService(createTreasuryService({
      getRooms: () => Object.values(Game.rooms),
      holderExists: () => true,
    }));
    treasury.beginTick();
    expect(treasury.commitments().reservedProduction("W1N57", "U")).toBe(0);
    const rebuildsBefore = treasury.metrics().commitmentRebuilds;

    // 权威 mutation（reserveProductionResource 内部 bump revision）。
    Memory.runtime = { resourceReservations: {} } as unknown as Memory["runtime"];
    reserveProductionResource("W1N57", "U" as ResourceConstant, 400, "lab-1");
    expect(readTreasuryCommitmentRevision()).toBeGreaterThan(0);

    const before = JSON.stringify(Memory.runtime);
    const updated = treasury.commitments();
    expect(treasury.metrics().commitmentRebuilds).toBeGreaterThan(rebuildsBefore);
    expect(updated.reservedProduction("W1N57", "U")).toBe(400);
    expect(updated.revision).toBe(readTreasuryCommitmentRevision());
    // 查询零写。
    treasury.query({ resource: "U", rooms: ["W1N57"] });
    expect(JSON.stringify(Memory.runtime)).toBe(before);
  });

  it("无 bump 的重复查询复用缓存（revision 未变不重建）", () => {
    const treasury = treasuryTestService(createTreasuryService({
      getRooms: () => Object.values(Game.rooms),
      holderExists: () => true,
    }));
    treasury.beginTick();
    const first = treasury.commitments();
    const rebuilds = treasury.metrics().commitmentRebuilds;
    expect(treasury.commitments()).toBe(first);
    expect(treasury.metrics().commitmentRebuilds).toBe(rebuilds);
  });
});

describe("holder 存在性默认解析（logical 命名空间不再误判 orphan）", () => {
  it("默认 holderExists：`nuker:` 逻辑名与裸 object id 判活，未知 id 才 orphan", () => {
    installEmpire();
    const originalGetObjectById = Game.getObjectById;
    Game.getObjectById = ((id: string) =>
      id === "nuker-real" ? { room: { name: "W1N57" } } : null) as never;
    try {
      const observation = createTreasuryService({ getRooms: () => Object.values(Game.rooms) }).observation();
      // nuker 逻辑名（生产写入形态 `nuker:<nukerId>:<resource>`）：嵌入 id
      // 存在 → 不 orphan，committed 照常扣除（不得低估）。
      // 裸 game object id 存在 → 不 orphan。
      // 确证不存在的 id → orphan 读侧排除并计数。
      const index = buildTreasuryCommitmentIndex({
        tick: Game.time,
        tasks: {},
        reservations: {
          "k1": { roomName: "W1N57", resource: "G", holderId: "nuker:nuker-real:G", amount: 100, expiresAt: Game.time + 100 },
          "k2": { roomName: "W1N57", resource: "G", holderId: "nuker-real", amount: 50, expiresAt: Game.time + 100 },
          "k3": { roomName: "W1N57", resource: "G", holderId: "gone-id", amount: 25, expiresAt: Game.time + 100 },
        },
        observation,
      });
      // owner 无法确证失效（gone-id）保守计入 committed；只有到期解除。
      expect(index.reservedProduction("W1N57", "G")).toBe(175);
      expect(index.metrics.missingOwnerStillCommitted).toBe(2);
      expect(index.metrics.typedOwnerResolved).toBe(1);
      expect(index.metrics.activeReservationRecords).toBe(3);
    } finally {
      Game.getObjectById = originalGetObjectById;
    }
  });
});
