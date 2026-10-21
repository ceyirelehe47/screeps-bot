import { MockPos } from "@mock/powerBank";

jest.mock("@/movement/routing", () => ({ getCachedStaticTravelMatrix: jest.fn(() => ({ get: () => 0 })) }));
jest.mock("@/runtime/powerBankSearch", () => ({
  POWER_BANK_SEARCH_RADIUS: 10,
  getPowerBankSearchCandidates: jest.fn(() => ["E0N57"]),
}));

const HIGHWAY = "E0N57";

type IndexModule = typeof import("@/runtime/powerBankSourceIndex");

function ownedRoom(name: string, level: number): Room {
  const room = {
    name,
    controller: { my: true, level },
    energyCapacityAvailable: 12_000,
    storage: { pos: new RoomPosition(20, 20, name) },
    find: jest.fn(() => []),
  } as unknown as Room;
  Game.spawns[`${name}:spawn`] = {
    id: `${name}:spawn`, name: `${name}:spawn`, room, pos: new RoomPosition(11, 10, name),
    memory: { spawnList: [] }, spawning: null, isActive: () => true,
  } as unknown as StructureSpawn;
  return room;
}

describe("PB 高速房来源索引", () => {
  let index: IndexModule;
  let costs: Record<string, number>;
  let search: jest.Mock;

  function setup(rooms: Array<[string, number]>): void {
    jest.resetModules();
    delete (global as typeof global & { __runtimeServices?: unknown }).__runtimeServices;
    Object.assign(global, { RoomPosition: MockPos });
    Game.time = 1_000;
    Game.creeps = {};
    Game.spawns = {};
    Game.rooms = {};
    Game.cpu = { ...Game.cpu, limit: 120, tickLimit: 500, bucket: 10_000, getUsed: jest.fn(() => 0) };
    Memory.runtime = {};
    Memory.data = { powerBankHarvest: {} };
    for (const [name, level] of rooms) Game.rooms[name] = ownedRoom(name, level);
    Game.map = {
      ...Game.map,
      getRoomStatus: jest.fn(() => ({ status: "normal", timestamp: null })),
      describeExits: jest.fn(() => ({})),
      getRoomLinearDistance: jest.fn(() => 2),
      findRoute: jest.fn((_from: string, to: string) => [{ room: to, exit: FIND_EXIT_LEFT }]),
    } as unknown as GameMap;
    search = jest.fn((origin: RoomPosition, goal: { pos: RoomPosition }) => ({
      path: [new RoomPosition(25, 25, goal.pos.roomName)], incomplete: false, ops: 10, cost: costs[origin.roomName],
    }));
    Object.assign(global, { PathFinder: { CostMatrix: class {}, search } });
    const services = require("@/runtime/runtimeServices") as typeof import("@/runtime/runtimeServices");
    services.registerRuntimeServices();
    index = require("@/runtime/powerBankSourceIndex") as IndexModule;
  }

  function runTicks(count: number): void {
    for (let tick = 0; tick < count; tick += 1) {
      index.runPowerBankSourceIndex();
      Game.time += 1;
    }
  }

  it("RCL8 优先按实测行程排序取前 3，更近的 RCL7 不入表；每 tick 至多一次搜索", () => {
    costs = { E1N57: 300, E2N57: 100, E3N57: 50, E4N57: 200, E5N57: 400 };
    setup([["E1N57", 8], ["E2N57", 8], ["E3N57", 7], ["E4N57", 8], ["E5N57", 8]]);
    expect(index.getPowerBankSourceIndexEntry(HIGHWAY)).toBeUndefined();
    let previous = 0;
    for (let tick = 0; tick < 10; tick += 1) {
      index.runPowerBankSourceIndex();
      expect(search.mock.calls.length - previous).toBeLessThanOrEqual(1);
      previous = search.mock.calls.length;
      Game.time += 1;
    }
    expect(index.getPowerBankSourceIndexEntry(HIGHWAY)?.map((entry) => entry.room)).toEqual(["E2N57", "E4N57", "E1N57"]);
    expect(search.mock.calls.some(([origin]) => (origin as RoomPosition).roomName === "E3N57")).toBe(false);
    expect(index.getPowerBankSourceIndexTicks(HIGHWAY, "E2N57")).toBe(100);
    // 已完成：后续 tick 为 no-op。
    const settled = search.mock.calls.length;
    runTicks(5);
    expect(search.mock.calls.length).toBe(settled);
  });

  it("没有 RCL8 时以 RCL6/7 兜底；Memory 紧凑备份在 global reset 后恢复，RCL 变化使其失效", () => {
    costs = { E1N57: 120, E2N57: 80 };
    setup([["E1N57", 7], ["E2N57", 6]]);
    runTicks(5);
    expect(index.getPowerBankSourceIndexEntry(HIGHWAY)?.map((entry) => entry.room)).toEqual(["E2N57", "E1N57"]);
    expect(Memory.runtime!.powerBankSourceIndex!.rooms[HIGHWAY]).toMatch(/E2N57:80:6,E1N57:120:7\|[a-z0-9]+\|\{/);

    index.resetPowerBankSourceIndexForTest();
    expect(index.getPowerBankSourceIndexEntry(HIGHWAY)?.map((entry) => entry.room)).toEqual(["E2N57", "E1N57"]);

    (Game.rooms.E1N57.controller as { level: number }).level = 8;
    Game.time += 1;
    expect(index.getPowerBankSourceIndexEntry(HIGHWAY)).toBeUndefined();
    runTicks(5);
    expect(index.getPowerBankSourceIndexEntry(HIGHWAY)?.map((entry) => entry.room)).toEqual(["E1N57"]);
  });

  it("有待准入任务或 CPU 余量不足时让出测量名额", () => {
    costs = { E1N57: 100 };
    setup([["E1N57", 8]]);
    Memory.data!.powerBankHarvest = { t: { status: "discovered" } as PowerBankHarvestTask };
    runTicks(3);
    expect(search).not.toHaveBeenCalled();
    Memory.data!.powerBankHarvest = {};
    jest.mocked(Game.cpu.getUsed).mockReturnValue(400);
    runTicks(3);
    expect(search).not.toHaveBeenCalled();
    jest.mocked(Game.cpu.getUsed).mockReturnValue(0);
    runTicks(3);
    expect(index.getPowerBankSourceIndexEntry(HIGHWAY)?.map((entry) => entry.room)).toEqual(["E1N57"]);
  });

  it("未到重试时间的 discovery 不阻止后台索引，到期时仍让位给准入", () => {
    costs = { E1N57: 100 };
    setup([["E1N57", 8]]);
    Memory.data!.powerBankHarvest = { t: { status: "discovered", nextAttemptAt: Game.time + 20 } as PowerBankHarvestTask };
    runTicks(3);
    expect(index.getPowerBankSourceIndexEntry(HIGHWAY)?.[0].room).toBe("E1N57");
    const measured = search.mock.calls.length;
    Game.time += index.POWER_BANK_SOURCE_INDEX_REFRESH_TICKS;
    index.runPowerBankSourceIndex();
    expect(search.mock.calls.length).toBe(measured);
  });

  it("附近未经过的敌房不清空索引，实测途经房变危险时才失效，重启后保留依赖", () => {
    costs = { E1N57: 100 }; setup([["E1N57", 8]]);
    search.mockImplementation((_origin: RoomPosition, goal: { pos: RoomPosition }) => ({
      path: [new RoomPosition(25, 25, "E2N57"), new RoomPosition(25, 25, goal.pos.roomName)], incomplete: false, ops: 10, cost: 100,
    }));
    runTicks(5);
    expect(index.getPowerBankSourceIndexEntry(HIGHWAY)?.[0].room).toBe("E1N57");
    Memory.runtime!.powerBankOwnedRoomIntel = { E3N57: { owner: "enemy", lastSeenAt: Game.time } };
    Game.time++;
    expect(index.getPowerBankSourceIndexEntry(HIGHWAY)?.[0].room).toBe("E1N57");
    index.resetPowerBankSourceIndexForTest();
    expect(index.getPowerBankSourceIndexEntry(HIGHWAY)?.[0].room).toBe("E1N57");
    jest.mocked(Game.map.getRoomLinearDistance).mockImplementation((from, to) => from === "W99S99" || to === "W99S99" ? 100 : 2);
    Memory.runtime!.powerBankOwnedRoomIntel = { W99S99: { owner: "enemy", lastSeenAt: Game.time } };
    Game.time++;
    expect(index.getPowerBankSourceIndexEntry(HIGHWAY)?.[0].room).toBe("E1N57");
    Memory.runtime!.powerBankOwnedRoomIntel.E2N57 = { owner: "enemy", lastSeenAt: Game.time };
    Game.time++;
    expect(index.getPowerBankSourceIndexEntry(HIGHWAY)).toBeUndefined();
  });

  it("条目超过刷新周期后重测，期间旧条目继续可用", () => {
    costs = { E1N57: 100, E2N57: 200 };
    setup([["E1N57", 8], ["E2N57", 8]]);
    runTicks(4);
    expect(index.getPowerBankSourceIndexEntry(HIGHWAY)?.map((entry) => entry.room)).toEqual(["E1N57", "E2N57"]);
    Game.time += index.POWER_BANK_SOURCE_INDEX_REFRESH_TICKS;
    costs = { E1N57: 300, E2N57: 200 };
    index.runPowerBankSourceIndex();
    Game.time += 1;
    expect(index.getPowerBankSourceIndexEntry(HIGHWAY)?.map((entry) => entry.room)).toEqual(["E1N57", "E2N57"]);
    runTicks(4);
    expect(index.getPowerBankSourceIndexEntry(HIGHWAY)?.map((entry) => entry.room)).toEqual(["E2N57", "E1N57"]);
  });

  it("解除原有避让后重试不可达候选，不必等5000 tick刷新周期", () => {
    costs = { E1N57: 100 }; setup([["E1N57", 8]]);
    Memory.runtime!.powerBankPermanentDangerRooms = { E2N57: true };
    jest.mocked(Game.map.findRoute).mockImplementation((_from, to, opts) =>
      opts?.routeCallback?.("E2N57", "E1N57") === Infinity ? ERR_NO_PATH : [{ room: typeof to === "string" ? to : to.name, exit: FIND_EXIT_LEFT }]);
    runTicks(4);
    expect(index.getPowerBankSourceIndexEntry(HIGHWAY)).toBeUndefined();
    expect(search).not.toHaveBeenCalled();
    delete Memory.runtime!.powerBankPermanentDangerRooms.E2N57;
    Game.time++;
    runTicks(3);
    expect(index.getPowerBankSourceIndexEntry(HIGHWAY)?.[0].room).toBe("E1N57");
    expect(search).toHaveBeenCalledTimes(1);
  });
});
