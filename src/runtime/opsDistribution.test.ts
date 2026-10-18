import { cadenceOffset } from "@/runtime/cadence";
import { runOpsDistribution } from "@/runtime/opsDistribution";
import { createAutomaticResourceTransferTask } from "@/runtime/logistics/resourceTransferTasks";
import { createMockStore } from "@mock/powerBank";

describe("PC 跨房 OPS 补给", () => {
  function room(name: string, ops = 0): Room {
    const result = { name, controller: { my: true },
      storage: { store: createMockStore({ energy: 300000, ops }, 1000000) },
      terminal: { structureType: STRUCTURE_TERMINAL, isActive: () => true,
        store: createMockStore({ energy: 30000 }, 300000) },
    } as unknown as Room;
    Game.rooms[name] = result;
    return result;
  }
  function pc(home: Room, ops = 0, name = home.name): PowerCreep {
    const result = { name, memory: { homeRoom: home.name }, room: home, pos: { roomName: home.name },
      shard: "shard1", ticksToLive: 1000, store: createMockStore({ ops }, 2600),
      powers: { [PWR_OPERATE_STORAGE]: { level: 5, cooldown: 0 } },
    } as unknown as PowerCreep;
    Game.powerCreeps[name] = result;
    return result;
  }
  const tasks = () => Object.values(Memory.data?.resourceControl?.tasks || {}).filter(task => task.reason === "powerCreep:ops");
  beforeEach(() => {
    Game.time = 100 + cadenceOffset("opsDistribution.plan", 25);
    Game.rooms = {}; Game.powerCreeps = {};
    Game.shard = { name: "shard1", type: "normal", ptr: false };
    Game.market = { calcTransactionCost: jest.fn((amount: number) => Math.ceil(amount / 10)), orders: {} } as unknown as Market;
    Game.map = { ...Game.map, getRoomLinearDistance: jest.fn((from: string) => from === "E5N59" ? 1 : 5) };
    Memory.cfg = { resourceControl: { enabled: true } }; Memory.data = {};
  });

  it("复现 E4N58：本房断供且 PC 携带54，从最近供体补至2000，重复规划不加单", () => {
    const target = room("E4N58"); pc(target, 54);
    const near = room("E5N59", 5000); pc(near, 350);
    room("E6N59", 38000);
    runOpsDistribution();
    expect(tasks()).toHaveLength(1);
    expect(tasks()[0]).toMatchObject({ fromRoomName: near.name, toRoomName: target.name, resource: RESOURCE_OPS,
      amount: 1946, origin: "automatic" });
    runOpsDistribution(); Game.time += 25; runOpsDistribution();
    expect(tasks()).toHaveLength(1); expect(tasks()[0].remainingAmount).toBe(1946);
  });

  it("扣除供体已有承诺、保留本房2000，只分配真实剩余且同轮不重复承诺库存", () => {
    const source = room("E5N59", 4000); pc(source, 500);
    pc(room("E4N58")); pc(room("E3N59")); room("E7N59");
    createAutomaticResourceTransferTask(source.name, "E7N59", RESOURCE_OPS, 1000, "existing");
    runOpsDistribution();
    expect(tasks().reduce((sum, task) => sum + task.amount, 0)).toBe(1000);
  });

  it("健康在途覆盖需求；供体耗尽超时的旧任务不再掩盖缺口", () => {
    const target = room("E4N58"); pc(target, 54); room("E5N59", 10000); room("E6N59");
    const result = createAutomaticResourceTransferTask("E6N59", target.name, RESOURCE_OPS, 1946, "existing");
    runOpsDistribution(); expect(tasks()).toHaveLength(0);
    if (typeof result === "string") throw new Error(result);
    result.task.blockedReason = "source_depleted"; result.task.blockedSince = Game.time - 100;
    Game.time += 25; runOpsDistribution(); expect(tasks()[0].amount).toBe(1946);
  });

  it("按手续费和共享终端容量缩小批次，不挤占其他资源的在途容量", () => {
    const source = room("E5N59", 10000); const target = room("E4N58"); pc(target);
    source.terminal!.store = createMockStore({ energy: 25015 }, 300000);
    target.terminal!.store = createMockStore({ energy: 298800 }, 300000);
    room("E6N59"); createAutomaticResourceTransferTask("E6N59", target.name, RESOURCE_HYDROGEN, 1000, "existing");
    runOpsDistribution(); expect(tasks()[0].amount).toBe(150);
    source.terminal!.store[RESOURCE_ENERGY] = 30000; Game.time += 25; runOpsDistribution();
    // 仅余50容量时不派小于100的碎片单。
    expect(tasks().reduce((sum, task) => sum + task.remainingAmount, 0)).toBe(150);
  });

  it("500低水位以上、运输停用、终端不可用时不补给", () => {
    const target = room("E4N58"); const consumer = pc(target, 500); room("E5N59", 10000);
    runOpsDistribution(); expect(tasks()).toHaveLength(0);
    consumer.store[RESOURCE_OPS] = 0; Memory.cfg!.resourceControl!.enabled = false;
    runOpsDistribution(); expect(tasks()).toHaveLength(0);
    Memory.cfg!.resourceControl!.enabled = true; target.terminal!.isActive = () => false;
    runOpsDistribution(); expect(tasks()).toHaveLength(0);
  });

  it("不为未出生、其他 shard 或仅有免费技能的 PC 派单", () => {
    const target = room("E4N58"); const consumer = pc(target); room("E5N59", 10000);
    Object.assign(consumer, { ticksToLive: undefined }); runOpsDistribution(); expect(tasks()).toHaveLength(0);
    Object.assign(consumer, { ticksToLive: 1000, shard: "shard2" }); runOpsDistribution(); expect(tasks()).toHaveLength(0);
    Object.assign(consumer, { shard: "shard1", powers: { [PWR_GENERATE_OPS]: { level: 5, cooldown: 0 } } });
    runOpsDistribution(); expect(tasks()).toHaveLength(0);
  });
});
