/**
 * Treasury Core 单元测试（observation + facade query + 服务挂载）：
 * - 稀疏枚举正确性与确定性操作计数（storeEnumerations/resourceKeys/
 *   roomFindCalls=0/fallbackLiveReads=0）；
 * - Observed 不可变（冻结数据写入抛错）、同 tick 引用复用、tick 切换重建；
 * - 帝国总量 = Σ位置桶；missing 位置 exists=false；
 * - fresh scope 与 shared 缓存隔离、stale epoch 判定；
 * - 带上下文查询（observed/projected/committed/spendable/overcommitted/
 *   withhold/incoming/locations 过滤）；spendable 非负；
 * - RuntimeServices 挂载与 resetForTest。
 */
import { createTreasuryService, type TreasuryService } from "@/runtime/treasury/facade";
import { getRuntimeServices, getTreasuryService, registerRuntimeServices } from "@/runtime/runtimeServices";
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

function makeStore(resources: Record<string, number>, freeCapacity = 500_000): StoreDefinition {
  const store = Object.create(storePrototype) as StoreDefinition;
  for (const [resource, amount] of Object.entries(resources)) {
    (store as unknown as Record<string, number>)[resource] = amount;
  }
  Object.defineProperty(store, "__freeCapacity", {
    value: freeCapacity,
    enumerable: false,
    writable: true,
  });
  return store;
}

interface RoomSpec {
  name: string;
  storage?: { id: string; resources: Record<string, number>; freeCapacity?: number } | null;
  terminal?: { id: string; resources: Record<string, number>; freeCapacity?: number } | null;
}

function installRooms(specs: RoomSpec[]): Record<string, Room> {
  const rooms: Record<string, Room> = {};
  for (const spec of specs) {
    rooms[spec.name] = {
      name: spec.name,
      controller: { my: true, level: 8 },
      storage:
        spec.storage === null || !spec.storage
          ? undefined
          : ({
              id: spec.storage.id,
              store: makeStore(spec.storage.resources, spec.storage.freeCapacity ?? 500_000),
            } as unknown as StructureStorage),
      terminal:
        spec.terminal === null || !spec.terminal
          ? undefined
          : ({
              id: spec.terminal.id,
              store: makeStore(spec.terminal.resources, spec.terminal.freeCapacity ?? 300_000),
            } as unknown as StructureTerminal),
    } as unknown as Room;
  }
  Game.rooms = rooms;
  return rooms;
}

function makeService(rooms: Record<string, Room>): TreasuryService {
  return createTreasuryService({ getRooms: () => Object.values(rooms) });
}

const ROOM_SPECS: RoomSpec[] = [
  {
    name: "W1N57",
    storage: { id: "stor-1", resources: { energy: 400_000, U: 5_000 } },
    terminal: { id: "term-1", resources: { energy: 50_000, U: 2_000, OH: 300 } },
  },
  {
    name: "E1N57",
    storage: { id: "stor-2", resources: { energy: 200_000, K: 40_000 } },
    terminal: null,
  },
  { name: "E3N59", storage: null, terminal: { id: "term-3", resources: { energy: 10_000 } } },
];

beforeEach(() => {
  clearRuntimeServicesForTest();
  Game.time = 1000;
  installRooms(ROOM_SPECS);
});

describe("Treasury observation 物理事实", () => {
  it("稀疏枚举每房间 storage/terminal 数值并保留缺失位置", () => {
    const treasury = makeService(Game.rooms);
    const observation = treasury.observation();

    expect(observation.amount("W1N57", "storage", RESOURCE_ENERGY)).toBe(400_000);
    expect(observation.amount("W1N57", "storage", "U")).toBe(5_000);
    expect(observation.amount("W1N57", "terminal", "OH")).toBe(300);
    expect(observation.amount("E1N57", "terminal", RESOURCE_ENERGY)).toBe(0);
    expect(observation.locationExists("E1N57", "terminal")).toBe(false);
    expect(observation.locationExists("E1N57", "storage")).toBe(true);
    expect(observation.location("E1N57", "terminal").exists).toBe(false);
    expect(observation.location("W1N57", "storage").structureId).toBe("stor-1");

    const metrics = treasury.metrics();
    // 3 房间 × 2 位置 = 6 次受管辖 Store 枚举（missing 不枚举 → 实际 4 个存在结构）。
    expect(metrics.storeEnumerations).toBe(4);
    // 非零 key：stor-1(2) + term-1(3) + stor-2(2) + term-3(1) = 8。
    expect(metrics.resourceKeysEnumerated).toBe(8);
    expect(metrics.roomFindCalls).toBe(0);
    expect(metrics.fallbackLiveReads).toBe(0);
  });

  it("帝国总量等于全部位置桶之和且资源并集正确", () => {
    const treasury = makeService(Game.rooms);
    const observation = treasury.observation();

    // energy: 400000+50000+200000+10000 = 660000；U: 5000+2000；K/OH 单点。
    expect(observation.empireTotal(RESOURCE_ENERGY)).toBe(660_000);
    expect(observation.empireTotal("U")).toBe(7_000);
    expect(observation.empireTotal("K")).toBe(40_000);
    expect(observation.empireTotal("OH")).toBe(300);
    expect([...observation.empireResources()].sort()).toEqual(["OH", "U", "energy", "K"].sort());

    // 手工重算 Σ桶 验证守恒。
    let manualEnergy = 0;
    for (const roomName of observation.roomNames()) {
      manualEnergy += observation.amount(roomName, "storage", RESOURCE_ENERGY);
      manualEnergy += observation.amount(roomName, "terminal", RESOURCE_ENERGY);
    }
    expect(observation.empireTotal(RESOURCE_ENERGY)).toBe(manualEnergy);

    expect(observation.roomAmount("W1N57", "U")).toBe(7_000);
    expect([...observation.roomResources("E3N59")]).toEqual(["energy"]);
  });

  it("Observed 数据不可变（写入冻结字段抛错）且同 tick 引用复用", () => {
    const treasury = makeService(Game.rooms);
    const first = treasury.observation();
    const second = treasury.observation();

    expect(second).toBe(first);
    expect(treasury.metrics().observationReuseHits).toBeGreaterThan(0);

    const storage = first.data.rooms[0].storage;
    expect(() => {
      (storage.amounts as Record<string, number>).energy = 1;
    }).toThrow();
    expect(() => {
      ((first.data as unknown) as { rooms: unknown[] }).rooms = [];
    }).toThrow();
    // 观察后修改 Game store 不影响已冻结观察。
    (Game.rooms.W1N57.storage!.store as unknown as Record<string, number>).energy = 123;
    expect(first.amount("W1N57", "storage", RESOURCE_ENERGY)).toBe(400_000);

    // 物理事实不持久化：构建/查询路径不向 Memory 写任何观察副本
    // （Memory 仍只有 mock 初始字段，无 data/runtime/物理数值落盘）。
    const memorySnapshot = JSON.stringify(Memory);
    expect(memorySnapshot).toBe(JSON.stringify({ creeps: {}, rooms: {} }));
    expect(Memory.data).toBeUndefined();
    expect(Memory.runtime).toBeUndefined();
  });

  it("tick 切换重建 observation 且 epoch 单调递增", () => {
    const treasury = makeService(Game.rooms);
    const first = treasury.observation();
    const firstEpoch = first.epoch;

    Game.time = 1001;
    (Game.rooms.W1N57.storage!.store as unknown as Record<string, number>).energy = 410_000;
    const second = treasury.observation();

    expect(second).not.toBe(first);
    expect(second.epoch.observedAtTick).toBe(1001);
    expect(second.epoch.epochSeq).toBeGreaterThan(firstEpoch.epochSeq);
    expect(second.amount("W1N57", "storage", RESOURCE_ENERGY)).toBe(410_000);
    // 旧 view 在新 tick 下判定 stale。
    expect(first.isStale()).toBe(true);
    expect(second.isStale()).toBe(false);
  });

  it("fresh observation 独立构建且不污染 shared 缓存", () => {
    const treasury = makeService(Game.rooms);
    const shared = treasury.observation();

    const fresh = treasury.beginFreshObservation();
    expect(fresh.epoch.scope).toBe("market-fresh");
    expect(fresh.epoch.epochSeq).toBeGreaterThan(shared.epoch.epochSeq);
    expect(treasury.metrics().freshObservationBuilds).toBe(1);

    // fresh 后 shared 仍是原引用（隔离不变量）。
    expect(treasury.observation()).toBe(shared);
    // fresh 数值与 shared 一致（同 tick 同世界）。
    expect(fresh.amount("W1N57", "storage", RESOURCE_ENERGY)).toBe(400_000);
    expect(fresh.empireTotal("U")).toBe(shared.empireTotal("U"));
  });
});

describe("Treasury 带上下文查询", () => {
  function seedTasks(tasks: Record<string, ResourceTransferTask>): void {
    Memory.data = { resourceControl: { tasks, taskSchemaVersion: 2 } } as unknown as Memory["data"];
  }

  function makePendingTask(id: string, from: string, to: string, resource: string, remaining: number, origin: "manual" | "automatic" = "automatic", lastProgressAt = 1000): ResourceTransferTask {
    return {
      id,
      resource: resource as ResourceConstant,
      fromRoomName: from,
      toRoomName: to,
      amount: remaining,
      remainingAmount: remaining,
      status: "pending",
      createdAt: 990,
      updatedAt: 1000,
      origin,
      lastProgressAt,
    } as ResourceTransferTask;
  }

  it("query 聚合 observed/projected/committed/spendable 并按 locations/rooms 过滤", () => {
    const treasury = createTreasuryService({
      getRooms: () => Object.values(Game.rooms),
      holderExists: () => true,
    });
    seedTasks({
      "t1": makePendingTask("t1", "W1N57", "E1N57", "U", 3_000),
    });
    Memory.runtime = {
      resourceReservations: {
        "W1N57:U:lab-1": { roomName: "W1N57", resource: "U", holderId: "lab-1", amount: 1_500, updatedAt: 1000, expiresAt: 1200 },
      },
    } as unknown as Memory["runtime"];

    const view = treasury.query({ resource: "U", rooms: ["W1N57"] });
    expect(view.observed).toBe(7_000);
    expect(view.committed).toBe(4_500);
    expect(view.spendable).toBe(2_500);
    expect(view.overcommitted).toBe(false);

    // terminal-only 视图（transferable 语义）。
    const terminalView = treasury.query({ resource: "U", rooms: ["W1N57"], locations: ["terminal"] });
    expect(terminalView.observed).toBe(2_000);
    expect(terminalView.committed).toBe(4_500);
    expect(terminalView.spendable).toBe(0);
    expect(terminalView.overcommitted).toBe(true);

    // holder 不存在（未注入 holderExists 的默认服务）→ 孤儿预留排除。
    const orphanExcluded = makeService(Game.rooms).query({ resource: "U", rooms: ["W1N57"] });
    expect(orphanExcluded.committed).toBe(3_000);
  });

  it("withhold 策略保留与 allowIncoming 计入入站", () => {
    const treasury = makeService(Game.rooms);
    seedTasks({
      "t2": makePendingTask("t2", "E3N59", "W1N57", "K", 10_000),
    });

    const noIncoming = treasury.query({ resource: "K", rooms: ["W1N57"] });
    expect(noIncoming.observed).toBe(0);
    expect(noIncoming.spendable).toBe(0);

    const withIncoming = treasury.query({ resource: "K", rooms: ["W1N57"], allowIncoming: true });
    expect(withIncoming.incoming).toBe(10_000);
    expect(withIncoming.spendable).toBe(10_000);

    const withheld = treasury.query({ resource: "K", rooms: ["W1N57"], allowIncoming: true, withhold: 12_000 });
    expect(withheld.spendable).toBe(0);
    expect(withheld.overcommitted).toBe(true);
  });

  it("projected 查询叠加 journal delta 而不修改 observed", () => {
    const treasury = makeService(Game.rooms);
    treasury.recordAcceptedAction({
      actionId: "send-1",
      kind: "terminal.send",
      roomName: "W1N57",
      locationKind: "terminal",
      resource: "U",
      delta: -1_000,
      source: "test",
    });

    const view = treasury.query({ resource: "U", rooms: ["W1N57"] });
    expect(view.observed).toBe(7_000);
    expect(view.projected).toBe(6_000);

    const observedOnly = treasury.query({ resource: "U", rooms: ["W1N57"], allowProjected: false, subtractOutgoing: false, subtractReservations: false });
    expect(observedOnly.projected).toBe(7_000);
  });
});

describe("RuntimeServices 集成", () => {
  it("treasury 服务经 runtimeServices 挂载并可 resetForTest", () => {
    const services = registerRuntimeServices();
    expect(getTreasuryService()).toBe(services.treasury);
    expect(getRuntimeServices().treasury.observation().amount("W1N57", "storage", RESOURCE_ENERGY)).toBe(400_000);

    services.treasury.resetForTest();
    const metrics = services.treasury.metrics();
    expect(metrics.observationRebuilds).toBe(0);
    expect(metrics.storeEnumerations).toBe(0);
    expect(services.treasury.observation().amount("W1N57", "storage", RESOURCE_ENERGY)).toBe(400_000);
  });
});
