import { runPowerDistribution } from "@/runtime/powerDistribution";
import { createMockStore } from "@mock/powerBank";

describe("Power就近分发加工", () => {
  const processors = new Map<string, StructurePowerSpawn>();
  function room(name: string, power: number, energy = 300_000, process = true): Room {
    const r = { name, controller: { my: true }, terminal: { structureType: STRUCTURE_TERMINAL, isActive: () => true,
      store: createMockStore({ [RESOURCE_POWER]: power, [RESOURCE_ENERGY]: 30_000 }, 300_000) },
      storage: { store: createMockStore({ [RESOURCE_ENERGY]: energy }, 1_000_000) } } as unknown as Room;
    if (process) processors.set(name, { store: createMockStore({}, 5100), effects: [] } as unknown as StructurePowerSpawn);
    return r;
  }
  const tasks = () => Object.values(Memory.data?.resourceControl?.tasks ?? {});
  beforeEach(() => {
    processors.clear(); Game.time = 100; Memory.cfg = { resourceControl: { enabled: true } }; Memory.data = {};
    Game.market = { calcTransactionCost: jest.fn((amount: number) => Math.ceil(amount / 10)), orders: {} } as unknown as Market;
    Game.map = { ...Game.map, getRoomLinearDistance: jest.fn((from: string, to: string) => from === "E1N1" && to === "E2N1" ? 1 : 5) } as GameMap;
  });

  it("先分给附近的活跃处理房，源房留500处理库存，重复运行不追加相同需求", () => {
    const rooms = [room("E1N1", 2000), room("E2N1", 0), room("E6N1", 0)];
    runPowerDistribution(rooms, processors);
    expect(tasks()).toHaveLength(2);
    expect(tasks()[0]).toMatchObject({ fromRoomName: "E1N1", toRoomName: "E2N1", resource: RESOURCE_POWER, amount: 500, origin: "automatic", reason: "powerProcessing:nearby" });
    runPowerDistribution(rooms, processors); expect(tasks()).toHaveLength(2);
  });

  it("没有PowerSpawn的采集源房也可分发，低能量或无处理设施的目标不接收", () => {
    const rooms = [room("E1N1", 2000, 300_000, false), room("E2N1", 0, 50_000), room("E6N1", 0, 300_000, false), room("E7N1", 0)];
    runPowerDistribution(rooms, processors);
    expect(tasks()).toHaveLength(1); expect(tasks()[0].toRoomName).toBe("E7N1");
  });

  it("目标已有运输承诺时不重复分配，也不把承诺给其它房间的Power再分出去", () => {
    const rooms = [room("E1N1", 1100), room("E2N1", 0)];
    Memory.data = { resourceControl: { taskSchemaVersion: 2, tasks: { existing: { id: "existing", resource: RESOURCE_POWER, fromRoomName: "E1N1", toRoomName: "E2N1", amount: 500, remainingAmount: 500, status: "pending", origin: "automatic", createdAt: 100, updatedAt: 100, lastProgressAt: 100 } } } } as Memory["data"];
    runPowerDistribution(rooms, processors); expect(tasks()).toHaveLength(1);
  });

  it("终端没有费用余量或目标没有容量时不派单", () => {
    const source = room("E1N1", 2000); source.terminal!.store = createMockStore({ [RESOURCE_POWER]: 2000, [RESOURCE_ENERGY]: 20_000 }, 300_000);
    const target = room("E2N1", 0); runPowerDistribution([source, target], processors); expect(tasks()).toHaveLength(0);
    source.terminal!.store = createMockStore({ [RESOURCE_POWER]: 2000, [RESOURCE_ENERGY]: 30_000 }, 300_000);
    target.terminal!.store = createMockStore({ [RESOURCE_ENERGY]: 300_000 }, 300_000);
    runPowerDistribution([source, target], processors); expect(tasks()).toHaveLength(0);
  });

  it("运输系统停用时保持停用，源房库存不足自身处理库存时不往返搬运", () => {
    const rooms = [room("E1N1", 600), room("E2N1", 0)];
    Memory.cfg!.resourceControl!.enabled = false;
    runPowerDistribution(rooms, processors); expect(tasks()).toHaveLength(0);
    Memory.cfg!.resourceControl!.enabled = true; rooms[0].terminal!.store[RESOURCE_POWER] = 599;
    runPowerDistribution(rooms, processors); expect(tasks()).toHaveLength(0);
  });
});
