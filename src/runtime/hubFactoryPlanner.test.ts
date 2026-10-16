import { createMockFactory, createMockStore } from "@mock/powerBank";
import { planHubFactory } from "@/runtime/hubFactoryPlanner";
import { runFactoryControl } from "@/runtime/factoryControl";
import { clearCarrierTaskBoardForTest, listCarrierTasksByRoom } from "@/runtime/carrierTaskBoard";
import { createResourceTransferTask, ensureResourceTransferTaskStore } from "@/runtime/logistics/resourceTransferTasks";
import { buildHubProgressSnapshot, buildHubVisualModel, drawHubVisualPanel } from "@/runtime/hubProgress";

function makeRoom(name: string, resources: Record<string, number>, contents: Record<string, number> = {}) {
  const factory = createMockFactory({ id: `${name}-factory`, roomName: name, store: createMockStore(contents, 50000) });
  const storage = { id: `${name}-storage`, structureType: STRUCTURE_STORAGE, store: createMockStore(resources, 4000000) } as unknown as StructureStorage;
  const terminal = { id: `${name}-terminal`, structureType: STRUCTURE_TERMINAL, store: createMockStore({}, 300000), cooldown: 0 } as unknown as StructureTerminal;
  const structures = [factory, storage, terminal];
  const room = { name, controller: { my: true, level: 8 }, storage, terminal,
    find: (_type: number, options?: { filter?: (s: AnyStructure) => boolean }) => options?.filter ? structures.filter(options.filter) : structures,
  } as unknown as Room;
  return { room, factory, storage };
}

function setup(resources: Record<string, number> = { energy: 300000, X: 40000 }) {
  const hub = makeRoom("W1N1", resources);
  Game.time = 1000;
  (Game as any).rooms = { W1N1: hub.room };
  (Game as any).map = { getRoomLinearDistance: jest.fn(() => 1) };
  Memory.cfg = { hub: { enabled: true, hubRoomName: "W1N1" }, factoryControl: { enabled: true } };
  return hub;
}

describe("HUB 工厂规划和执行", () => {
  beforeEach(() => clearCarrierTaskBoardForTest());

  it("只压缩本地余矿，保留底仓并限制成品库存", () => {
    setup();
    planHubFactory();
    const roomConfig = Memory.cfg!.factoryControl!.rooms!.W1N1;
    expect(roomConfig.managedBy).toBe("hubFactoryPlanner");
    expect(roomConfig.targets?.[0]).toEqual({ resource: "purifier", targetAmount: 5000, cap: 5099 });
    expect(roomConfig.resourceFloors).toMatchObject({ X: 20000, energy: 200000 });
    expect(Object.values(ensureResourceTransferTaskStore())).toHaveLength(0);
  });

  it("不为压缩从其它房间拉原矿，也不生产缺少区域原料的基础商品", () => {
    setup({ energy: 300000, X: 20499 });
    Game.rooms.W2N1 = makeRoom("W2N1", { energy: 300000, X: 50000 }).room;
    planHubFactory();
    expect(Memory.runtime!.factoryControl!.hubPlan!.targets).toHaveLength(0);
  });

  it("缺矿时按一批解压需求调拨，并计入健康在途避免重复派单", () => {
    setup({ energy: 300000, H: 19500 });
    Game.rooms.W2N1 = makeRoom("W2N1", { energy: 300000, reductant: 600 }).room;
    planHubFactory();
    expect(Memory.runtime!.factoryControl!.hubPlan!.targets[0].resource).toBe("H");
    let tasks = Object.values(ensureResourceTransferTaskStore());
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ resource: "reductant", amount: 100, reason: "hub:factory:W1N1:reductant" });
    Game.time += 50;
    planHubFactory();
    tasks = Object.values(ensureResourceTransferTaskStore());
    expect(tasks.filter(t => t.status === "pending")).toHaveLength(1);
    expect(tasks[0].amount).toBe(100);
  });

  it("失效在途会被替换；手工任务不会被撤销", () => {
    setup({ energy: 300000, H: 19500 });
    Game.rooms.W2N1 = makeRoom("W2N1", { energy: 300000, reductant: 600 }).room;
    planHubFactory();
    const stale = Object.values(ensureResourceTransferTaskStore())[0];
    stale.lastProgressAt = Game.time - 6000;
    const manual = createResourceTransferTask("W2N1", "W1N1", "U", 100, "hub:factory:manual");
    expect(typeof manual).not.toBe("string");
    Game.time += 50;
    planHubFactory();
    expect(stale.status).toBe("cancelled");
    expect(Object.values(ensureResourceTransferTaskStore()).filter(t => t.origin === "automatic" && t.status === "pending")).toHaveLength(1);
    expect(Object.values(ensureResourceTransferTaskStore()).find(t => t.origin === "manual")?.status).toBe("pending");
  });

  it("尊重 HUB 的手动停用与自定义队列", () => {
    setup();
    const manual = { enabled: false, targets: [{ resource: "energy" as ResourceConstant, targetAmount: 80000 }] };
    Memory.cfg!.factoryControl!.rooms = { W1N1: manual };
    planHubFactory();
    expect(Memory.cfg!.factoryControl!.rooms!.W1N1).toBe(manual);
    expect(Memory.runtime!.factoryControl!.hubPlan!.status).toBe("manual");
  });

  it("迁移 HUB 只清理原自动队列并取消旧导入，保留其它房间的手工暂停", () => {
    setup({ energy: 300000, H: 19500 });
    Game.rooms.W2N1 = makeRoom("W2N1", { energy: 300000, reductant: 600 }).room;
    Memory.cfg!.factoryControl!.rooms = { W3N1: { enabled: false } };
    planHubFactory();
    Memory.cfg!.hub!.hubRoomName = "W2N1";
    planHubFactory();
    expect(Memory.cfg!.factoryControl!.rooms!.W1N1.drainOnly).toBe(true);
    expect(Memory.cfg!.factoryControl!.rooms!.W1N1.targets).toEqual([]);
    expect(Memory.cfg!.factoryControl!.rooms!.W3N1).toEqual({ enabled: false });
    expect(Object.values(ensureResourceTransferTaskStore()).every(t => t.status === "cancelled")).toBe(true);
  });

  it("缺能先解压电池，恢复到目标前不会反向压缩", () => {
    const hub = setup({ energy: 180000, battery: 5000 });
    planHubFactory();
    expect(Memory.runtime!.factoryControl!.hubPlan!.targets[0].resource).toBe("energy");
    hub.storage.store = createMockStore({ energy: 220000, battery: 1000 }, 4000000);
    Game.time += 50;
    planHubFactory();
    expect(Memory.runtime!.factoryControl!.hubPlan!.targets[0].resource).toBe("energy");
    expect(Memory.runtime!.factoryControl!.hubPlan!.targets.some(t => t.resource === "battery")).toBe(false);
  });

  it("能量过高才压缩电池，不消耗配置底仓", () => {
    setup({ energy: 450000 });
    planHubFactory();
    expect(Memory.runtime!.factoryControl!.hubPlan!.targets[0].resource).toBe("battery");
    Game.rooms.W1N1.storage!.store = createMockStore({ energy: 200599 }, 4000000);
    Game.time += 50;
    planHubFactory();
    expect(Memory.runtime!.factoryControl!.hubPlan!.targets).toHaveLength(0);
  });

  it("有区域原料才纳入基础商品，缺压缩矿时用内部调拨", () => {
    setup({ energy: 300000, U: 20000, silicon: 1000 });
    Game.rooms.W2N1 = makeRoom("W2N1", { energy: 300000, utrium_bar: 1000 }).room;
    planHubFactory();
    expect(Memory.runtime!.factoryControl!.hubPlan!.targets[0].resource).toBe("wire");
    expect(Object.values(ensureResourceTransferTaskStore())[0]).toMatchObject({ resource: "utrium_bar", amount: 100 });
  });

  it("不抢占供房的生产预留和已有出库任务", () => {
    setup({ energy: 300000, H: 19500 });
    Game.rooms.W2N1 = makeRoom("W2N1", { energy: 300000, reductant: 100 }).room;
    Memory.runtime = { resourceReservations: { held: { roomName: "W2N1", resource: "reductant", amount: 1, holderId: "lab", updatedAt: 1000, expiresAt: 1100 } } };
    planHubFactory();
    expect(Memory.runtime.factoryControl!.hubPlan!.targets).toHaveLength(0);
  });

  it("高阶链不自动定级工厂或触发 Power Creep 技能", () => {
    setup({ energy: 300000, X: 40000, composite: 10000, wire: 10000 });
    planHubFactory();
    expect(Memory.runtime!.factoryControl!.hubPlan!.targets.length).toBeGreaterThan(0);
    expect(Memory.runtime!.factoryControl!.hubPlan!.targets.every(t => !COMMODITIES[t.resource].level)).toBe(true);
  });

  it("自动解压只验当前一批，避免要求整目标原料以及递归压回原矿", () => {
    const hub = setup({ energy: 300000, H: 0, reductant: 100 });
    hub.factory.store = createMockStore({ energy: 200, reductant: 100 }, 50000);
    runFactoryControl();
    expect(hub.factory.produce).toHaveBeenCalledWith("H");
    expect(Memory.runtime!.factoryControl!.rooms.W1N1).toMatchObject({ lastProducedAt: 1000, lastProducedResource: "H", producedAmount: 500 });
  });

  it("已经满足目标的最后一批也必须卸出，避免成品滞留", () => {
    const hub = setup({ energy: 300000, purifier: 4900, X: 30000 });
    hub.factory.store = createMockStore({ purifier: 100 }, 50000);
    Memory.runtime = { factoryControl: { rooms: { W1N1: { stage: "producing", activeTarget: "purifier", lastTransitionAt: 999 } } } };
    runFactoryControl();
    expect(hub.factory.produce).not.toHaveBeenCalled();
    expect(listCarrierTasksByRoom("W1N1")[0]).toMatchObject({ type: "factory_unload", steps: [{ resource: "purifier" }] });
  });

  it("换配方时清理残料，HUB 停用时卸出存货", () => {
    const hub = setup();
    hub.factory.store = createMockStore({ silicon: 100 }, 50000);
    runFactoryControl();
    expect(listCarrierTasksByRoom("W1N1")[0]).toMatchObject({ type: "factory_unload", steps: [{ resource: "silicon" }] });
    Memory.cfg!.factoryControl!.hub = { enabled: false };
    Game.time++;
    runFactoryControl();
    expect(Memory.cfg!.factoryControl!.rooms!.W1N1.drainOnly).toBe(true);
    expect(listCarrierTasksByRoom("W1N1")[0].type).toBe("factory_unload");
  });

  it("满仓但本批消耗足以释放空间时可以生产", () => {
    const hub = setup({ energy: 300000 });
    Memory.cfg!.hub!.enabled = false;
    Memory.cfg!.factoryControl!.targets = [{ resource: "battery", targetAmount: 50 }];
    hub.factory.store = createMockStore({ energy: 2999 }, 3000);
    runFactoryControl();
    expect(hub.factory.produce).toHaveBeenCalledWith("battery");
  });

  it("HUB 状态投影与画面显示工厂的产品、阶段和缺料", () => {
    setup();
    const factory = { status: "acquiring", stage: "blocked", product: "H", missing: { reductant: 100 }, lastProducedAt: null };
    const transfer = createResourceTransferTask("W2N1", "W1N1", "reductant", 100, "hub:factory:W1N1:reductant");
    expect(typeof transfer).not.toBe("string");
    const snapshot = buildHubProgressSnapshot({ factory, hubConfig: Memory.cfg!.hub!, hubRuntime: null, synthesisRuntime: null,
      hubStorageStore: { energy: 300000 }, hubTerminalStore: {}, resourceControlRooms: null, transferTasks: ensureResourceTransferTaskStore(), currentTick: 1000 });
    expect(snapshot.factory).toEqual(factory);
    expect(snapshot.pendingImports).toBe(1);
    const visual = { text: jest.fn(), rect: jest.fn(), line: jest.fn() };
    drawHubVisualPanel(visual as any, buildHubVisualModel(snapshot));
    expect(visual.text.mock.calls.some(call => String(call[0]).includes("Factory"))).toBe(true);
    expect(visual.text.mock.calls.some(call => String(call[0]).includes("reductant:100"))).toBe(true);
  });
});


it("HUB 清料跟随真正选中的配方，跳过已满足的队首不会往返搬输入", () => {
  clearCarrierTaskBoardForTest(); Memory.runtime = undefined; Game.time = 1000;
  const w = makeRoom("W1N1", { energy: 300000, purifier: 100, H: 10000 }, { reductant: 100, energy: 200 });
  Game.rooms = { W1N1: w.room };
  Memory.cfg = { factoryControl: { enabled: true, rooms: { W1N1: { enabled: true, managedBy: "hubFactoryPlanner",
    targets: [{ resource: "purifier", targetAmount: 100 }, { resource: "H", targetAmount: 11000 }] } } } };
  const planner = jest.spyOn(require("@/runtime/hubFactoryPlanner"), "planHubFactory").mockImplementation(() => undefined);
  try { runFactoryControl(); } finally { planner.mockRestore(); }
  expect(listCarrierTasksByRoom("W1N1").some(task => task.type === "factory_unload" && task.steps.some(s => s.resource === "reductant"))).toBe(false);
  expect(w.factory.produce).toHaveBeenCalledWith("H");
});
