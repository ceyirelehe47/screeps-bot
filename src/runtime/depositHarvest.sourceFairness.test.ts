import { runDepositHarvest, canSpawnDepositConfig } from "@/runtime/depositHarvest";
import { recordDepositDiscovery } from "@/runtime/depositDiscovery";
import { clearDepositPathCacheForTest, measureDepositTravel } from "@/runtime/depositPathDistance";
import { DEPOSIT_BODY } from "@/runtime/depositViability";


// 整合真实 manager + path validator + 负缓存 + 1/2 测量预算。
// PF provider 只给原始路径；measureDepositTravel 不 mock。
jest.mock("@/movement/routing", () => ({ getCachedStaticTravelMatrix: () => {
  const matrix = { get: () => 0, clone: () => matrix }; return matrix;
} }));
jest.mock("@/movement/roomTopologyRevision", () => ({ getRoomTopologyRevision: () => "stable" }));
jest.mock("@/runtime/defenseMode", () => ({ isDefenseMode: () => false }));
jest.mock("@/runtime/powerBankObserver", () => ({ requestDepositObservation: () => true }));
jest.mock("@/config/spawnProfiles", () => ({ spawnProfiles: {} }));
jest.mock("@/runtime/runtimeServices", () => ({
  getMemoryService: () => jest.requireActual("@/runtime/memoryService").createRuntimeMemoryService(),
  getTickContextService: () => ({ getMyRooms: () => Object.values(Game.rooms).filter((r) => r.controller?.my) }),
  getCreepConfigService: (() => {
    const { createCreepConfigService } = jest.requireActual("@/runtime/creepConfigService");
    const { createRuntimeMemoryService } = jest.requireActual("@/runtime/memoryService");
    const service = createCreepConfigService(createRuntimeMemoryService());
    return () => service;
  })(),
}));

function pos(x: number, y: number, roomName: string): RoomPosition { return { x, y, roomName } as RoomPosition; }
function owned(name: string, x = 45): Room {
  return { name, controller: { my: true }, energyAvailable: 3_000, energyCapacityAvailable: 3_000,
    storage: { id: `storage-${name}`, pos: pos(x, 20, name), store: { getFreeCapacity: () => 1_000 } },
    find: () => [] } as unknown as Room;
}
function spawn(name: string, room: Room, x: number): StructureSpawn {
  return { name, room, pos: pos(x, 20, room.name), isActive: () => true, memory: { spawnList: [] } } as unknown as StructureSpawn;
}
const outbound = [pos(49, 20, "E9N1"), pos(0, 20, "E10N1"), pos(1, 20, "E10N1")];
const returned = [pos(0, 20, "E10N1"), pos(49, 20, "E9N1"), pos(48, 20, "E9N1"), pos(47, 20, "E9N1"), pos(46, 20, "E9N1")];
let search: jest.Mock;
beforeEach(() => {
  jest.clearAllMocks(); clearDepositPathCacheForTest(); Game.time = 100;
  Memory.cfg = {}; Memory.data = { creepConfigs: {} }; Memory.runtime = {}; Memory.creeps = {};
  Game.creeps = {};
  const first = owned("E10N0"); const near = owned("E9N1");
  Game.rooms = { E10N0: first, E9N1: near, E10N1: { name: "E10N1", find: () => [] } as unknown as Room };
  Game.spawns = { first: spawn("first", first, 10), near: spawn("near", near, 48) };
  const deposit = { id: "d1", pos: pos(2, 20, "E10N1"), depositType: RESOURCE_METAL,
    cooldown: 0, lastCooldown: 0, ticksToDecay: 5_000 } as unknown as Deposit;
  Game.getObjectById = jest.fn(() => deposit) as unknown as typeof Game.getObjectById;
  Game.map = {
    getRoomStatus: () => ({ status: "normal", timestamp: null }), getRoomTerrain: () => ({ get: () => 0 }),
    findRoute: (_from: string, to: string) => [{ room: to, exit: FIND_EXIT_RIGHT }],
  } as unknown as GameMap;
  Object.assign(global, { RoomPosition: class { constructor(public x: number, public y: number, public roomName: string) {} } });
  search = jest.fn((origin: RoomPosition, goal: { pos: RoomPosition }) => ({
    incomplete: origin.roomName === "E10N0",
    path: origin.roomName === "E9N1" ? outbound : goal.pos.roomName === "E9N1" ? returned : [],
    ops: 1, cost: 1,
  }));
  Object.assign(global, { PathFinder: { search } });
  recordDepositDiscovery(deposit);
});

describe("Deposit 多来源候选不会被首源负缓存饿死", () => {
  it("等hop首源incomplete后，预算候选+1重试，真实负cache命中释放下一源测量", () => {
    runDepositHarvest();
    const task = Memory.data!.depositHarvest!.d1;
    expect(task.status).toBe("discovered"); expect(task.nextAttemptAt).toBe(101);
    expect(search).toHaveBeenCalledTimes(1); expect(Object.keys(Memory.data!.creepConfigs!)).toHaveLength(0);
    Game.time = 101; runDepositHarvest();
    expect(task.status).toBe("spawning"); expect(task.sourceRoom).toBe("E9N1");
    expect(search).toHaveBeenCalledTimes(3);
    expect(search.mock.calls.filter(([origin]) => origin.roomName === "E10N0")).toHaveLength(1);
    const config = Memory.data!.creepConfigs![task.configName!];
    expect(canSpawnDepositConfig(task.configName!, config)).toBe(true);
  });
  it("cheap safe route先测近来源，不能由名字典序先耗预算测远源", () => {
    Game.map.findRoute = jest.fn((from: string, to: string) => from === "E10N0"
      ? [{ room: "E9N0", exit: FIND_EXIT_LEFT }, { room: "E9N1", exit: FIND_EXIT_TOP }, { room: to, exit: FIND_EXIT_RIGHT }]
      : [{ room: to, exit: FIND_EXIT_RIGHT }]) as unknown as GameMap["findRoute"];
    runDepositHarvest();
    expect(Memory.data!.depositHarvest!.d1.sourceRoom).toBe("E9N1");
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls.some(([origin]) => origin.roomName === "E10N0")).toBe(false);
  });
  it("近来源有第二activeSpawn未完整时，不允许partial ready，次tick全测完才启动", () => {
    delete Game.rooms.E10N0; delete Game.spawns.first;
    Game.spawns.near2 = spawn("near2", Game.rooms.E9N1, 47);
    search.mockImplementation((origin: RoomPosition, goal: { pos: RoomPosition }) => ({ incomplete: false, ops: 1, cost: 1,
      path: origin.roomName === "E9N1" ? (origin.x === 47 ? [pos(48, 20, "E9N1"), ...outbound] : outbound) : returned }));
    runDepositHarvest(); expect(Memory.data!.depositHarvest!.d1.status).toBe("discovered");
    expect(Object.keys(Memory.data!.creepConfigs!)).toHaveLength(0);
    Game.time += 1; runDepositHarvest();
    expect(Memory.data!.depositHarvest!.d1.status).toBe("spawning");
    expect(Memory.data!.depositHarvest!.d1.outboundTravelTicks).toBe(4);
    expect(search).toHaveBeenCalledTimes(4);
  });
  it("缓存ready后出现fresh危险仍不放行来源", () => {
    const warmed = measureDepositTravel({ origin: Game.spawns.near.pos,
      target: pos(2, 20, "E10N1"), returnTarget: Game.rooms.E9N1.storage!.pos,
      body: DEPOSIT_BODY, loadedAmount: 500, routeRooms: ["E9N1", "E10N1"], avoidRooms: [] });
    expect(warmed.status).toBe("ready");
    Game.time += 1; Memory.runtime!.transitDangerRooms = { E9N1: Game.time + 100 };
    runDepositHarvest();
    expect(Memory.data!.depositHarvest!.d1.status).toBe("discovered");
    expect(Object.keys(Memory.data!.creepConfigs!)).toHaveLength(0);
  });
});
