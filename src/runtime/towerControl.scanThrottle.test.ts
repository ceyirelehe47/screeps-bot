/**
 * Tower 普通受损结构扫描节流回归测试（任务书阶段 F）：
 * 无塔房间跳过；非扫描点复用缓存不重扫；目标修满立即退出候选；
 * 到达扫描点（房间 hash 错峰）重新扫描。
 */
import { clearTowerDamagedScanCacheForTest, runTowerControl } from "@/runtime/towerControl";
import { MockPos } from "@mock/powerBank";
import { resetRuntimeServices } from "@mock/movement";

function createStore(energy: number) {
  return {
    getUsedCapacity: (resource?: ResourceConstant) => (resource === RESOURCE_ENERGY ? energy : 0),
    getFreeCapacity: () => 0,
  };
}

function createTower(id: string, roomName: string): StructureTower {
  return {
    id: id as Id<StructureTower>,
    structureType: STRUCTURE_TOWER,
    pos: new MockPos(10, 10, roomName) as unknown as RoomPosition,
    store: createStore(1000),
    attack: jest.fn(() => OK),
    heal: jest.fn(() => OK),
    repair: jest.fn(() => OK),
  } as unknown as StructureTower;
}

function createDamagedRoad(id: string, roomName: string, hits: number): { structure: StructureRoad; setHits: (value: number) => void } {
  const road = {
    id,
    structureType: STRUCTURE_ROAD,
    hits,
    hitsMax: 5000,
    pos: new MockPos(20, 20, roomName),
  } as unknown as StructureRoad;
  return {
    structure: road,
    setHits(value: number) {
      (road as { hits: number }).hits = value;
    },
  };
}

function setupRoom(name: string, structures: Structure<StructureConstant>[], towers: StructureTower[]) {
  const find = jest.fn((type: FindConstant) => {
    if (type === FIND_STRUCTURES) return structures;
    if (type === FIND_MY_STRUCTURES) return towers;
    if (type === FIND_HOSTILE_CREEPS) return [];
    if (type === FIND_MY_CREEPS) return [];
    return [];
  });
  const room = {
    name,
    controller: { my: true },
    find,
  } as unknown as Room;
  Game.rooms[name] = room;
  return { room, find };
}

describe("tower damaged-structure scan throttle", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearTowerDamagedScanCacheForTest();
    Game.time += 1;
    Game.rooms = {};
    Game.creeps = {};
    Game.spawns = {};
    Memory.rooms = {};
    Memory.runtime = {};
    Memory.data = undefined;
  });

  it("没有 Tower 的房间不触发受损结构扫描", () => {
    const road = createDamagedRoad("road-1", "W1N1", 100);
    const { find } = setupRoom("W1N1", [road.structure], []);
    runTowerControl();
    // 塔列表/敌情仍需探测，但结构主扫描与应急路障扫描被跳过。
    expect(find.mock.calls.filter((call) => call[0] === FIND_STRUCTURES).length).toBe(0);
  });

  it("非扫描点复用缓存：结构主扫描每周期最多一次，维修目标仍可执行", () => {
    const tower = createTower("tower-1", "W2N1");
    const road = createDamagedRoad("road-1", "W2N1", 100);
    const { room, find } = setupRoom("W2N1", [tower as unknown as Structure<StructureConstant>, road.structure], [tower]);
    const byId = new Map<string, Structure<StructureConstant>>([
      [tower.id as string, tower as unknown as Structure<StructureConstant>],
      ["road-1", road.structure],
    ]);
    (Game as unknown as { getObjectById: unknown }).getObjectById = jest.fn(
      (id: string) => byId.get(id) ?? null,
    );

    // 第一次：建立缓存（首次调用必然扫描）。
    runTowerControl();
    const scansAfterFirst = find.mock.calls.filter((call) => call[0] === FIND_STRUCTURES).length;
    expect(scansAfterFirst).toBe(1);
    expect(tower.repair).toHaveBeenCalledWith(road.structure);

    // 推进到非扫描点：复用缓存，结构主扫描不再发生，维修继续。
    (tower.repair as jest.Mock).mockClear();
    Game.time += 1;
    runTowerControl();
    expect(find.mock.calls.filter((call) => call[0] === FIND_STRUCTURES).length).toBe(1);
    expect(tower.repair).toHaveBeenCalledWith(road.structure);

    // 目标修满：从候选消失，维修停止且立即触发重扫。
    road.setHits(5000);
    (tower.repair as jest.Mock).mockClear();
    runTowerControl();
    expect(tower.repair).not.toHaveBeenCalled();
    expect(find.mock.calls.filter((call) => call[0] === FIND_STRUCTURES).length).toBe(2);
    void room;
  });
});
