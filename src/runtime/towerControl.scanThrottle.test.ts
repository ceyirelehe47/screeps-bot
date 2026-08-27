/**
 * Tower 普通受损结构扫描节流回归测试：
 * 无塔房间跳过；战斗 tick 完全不扫描；非扫描点复用缓存不重扫；
 * 无损伤负缓存零解析；存在候选时新损伤最迟 2 tick 内重扫发现；
 * 目标修满立即退出候选；缓存容量有上限。
 */
import {
  clearTowerDamagedScanCacheForTest,
  getTowerDamagedScanCacheSizeForTest,
  runTowerControl,
} from "@/runtime/towerControl";
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

function createDamagedRoad(
  id: string,
  roomName: string,
  hits: number,
  x = 20,
  y = 20,
): { structure: StructureRoad; setHits: (value: number) => void } {
  const road = {
    id,
    structureType: STRUCTURE_ROAD,
    hits,
    hitsMax: 5000,
    pos: new MockPos(x, y, roomName),
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

  it("战斗 tick 完全不触发受损结构扫描", () => {
    const tower = createTower("tower-1", "W3N1");
    const road = createDamagedRoad("road-1", "W3N1", 100);
    const { find } = setupRoom("W3N1", [tower as unknown as Structure<StructureConstant>, road.structure], [tower]);
    const hostile = {
      id: "hostile-1",
      pos: new MockPos(25, 25, "W3N1"),
      hits: 3000,
      hitsMax: 3000,
      body: [],
    } as unknown as Creep;
    find.mockImplementation(
      (
        (type: FindConstant) => {
          if (type === FIND_STRUCTURES) return [road.structure];
          if (type === FIND_MY_STRUCTURES) return [tower];
          if (type === FIND_HOSTILE_CREEPS) return [hostile];
          if (type === FIND_MY_CREEPS) return [];
          return [];
        }
      ) as unknown as Room["find"],
    );

    runTowerControl();

    expect(tower.attack).toHaveBeenCalledWith(hostile);
    expect(find.mock.calls.filter((call) => call[0] === FIND_STRUCTURES).length).toBe(0);
  });

  it("无损伤负缓存：非扫描点零解析零扫描", () => {
    const tower = createTower("tower-1", "W4N1");
    const road = createDamagedRoad("road-1", "W4N1", 5000);
    const { find } = setupRoom("W4N1", [tower as unknown as Structure<StructureConstant>, road.structure], [tower]);
    const getObjectById = jest.fn(() => null);
    (Game as unknown as { getObjectById: unknown }).getObjectById = getObjectById;

    runTowerControl();
    expect(find.mock.calls.filter((call) => call[0] === FIND_STRUCTURES).length).toBe(1);
    const resolvesAfterScan = getObjectById.mock.calls.length;

    Game.time += 1;
    runTowerControl();
    Game.time += 1;
    runTowerControl();
    expect(find.mock.calls.filter((call) => call[0] === FIND_STRUCTURES).length).toBe(1);
    expect(getObjectById.mock.calls.length).toBe(resolvesAfterScan);
  });

  it("存在旧候选时新受损结构最迟 2 tick 内被重扫发现", () => {
    const tower = createTower("tower-1", "W5N1");
    const oldRoad = createDamagedRoad("road-old", "W5N1", 100);
    // 新路离塔更近（15,15 vs 20,20），重扫后应成为维修目标。
    const newRoad = createDamagedRoad("road-new", "W5N1", 50, 15, 15);
    const structures: Structure<StructureConstant>[] = [
      tower as unknown as Structure<StructureConstant>,
      oldRoad.structure,
    ];
    const { find } = setupRoom("W5N1", structures, [tower]);
    const byId = new Map<string, Structure<StructureConstant>>([
      ["road-old", oldRoad.structure],
      ["road-new", newRoad.structure],
    ]);
    (Game as unknown as { getObjectById: unknown }).getObjectById = jest.fn(
      (id: string) => byId.get(id) ?? null,
    );

    // tick 0：扫描建立旧候选缓存。
    runTowerControl();
    expect(find.mock.calls.filter((call) => call[0] === FIND_STRUCTURES).length).toBe(1);

    // tick 1：新道路受损加入房间；候选解析复用旧候选，不重扫。
    structures.push(newRoad.structure);
    Game.time += 1;
    runTowerControl();
    expect(find.mock.calls.filter((call) => call[0] === FIND_STRUCTURES).length).toBe(1);

    // tick 2：距上次扫描 ≥2 tick，触发重扫，新受损道路进入维修候选。
    Game.time += 1;
    (tower.repair as jest.Mock).mockClear();
    runTowerControl();
    expect(find.mock.calls.filter((call) => call[0] === FIND_STRUCTURES).length).toBe(2);
    // 重扫后新受损道路（更近）成为维修目标，证明其已进入候选。
    expect(tower.repair).toHaveBeenCalledWith(newRoad.structure);
  });

  it("缓存条目数不超过容量上限", () => {
    const byId = new Map<string, Structure<StructureConstant>>();
    (Game as unknown as { getObjectById: unknown }).getObjectById = jest.fn(
      (id: string) => byId.get(id) ?? null,
    );

    for (let index = 0; index < 35; index += 1) {
      const roomName = `W${index}N9`;
      const tower = createTower(`tower-${index}`, roomName);
      const road = createDamagedRoad(`road-${index}`, roomName, 100);
      byId.set(`road-${index}`, road.structure);
      setupRoom(roomName, [tower as unknown as Structure<StructureConstant>, road.structure], [tower]);
    }

    runTowerControl();

    expect(getTowerDamagedScanCacheSizeForTest()).toBeLessThanOrEqual(30);
  });
});
