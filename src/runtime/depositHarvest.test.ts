import { canSpawnDepositConfig, runDepositHarvest } from "@/runtime/depositHarvest";
import { recordDepositDiscovery } from "@/runtime/depositDiscovery";
import { measureDepositTravel, isDepositRoomSafe } from "@/runtime/depositPathDistance";
import type { CreepConfig } from "@/types/system";

jest.mock("@/runtime/defenseMode", () => ({ isDefenseMode: jest.fn(() => false) }));
jest.mock("@/runtime/powerBankObserver", () => ({ requestDepositObservation: jest.fn(() => true) }));
jest.mock("@/runtime/depositPathDistance", () => ({ isDepositRoomSafe: jest.fn(() => true), measureDepositTravel: jest.fn() }));
jest.mock("@/config/spawnProfiles", () => ({ spawnProfiles: { worker: () => [WORK, CARRY, MOVE] } }));
jest.mock("@/runtime/runtimeServices", () => ({
  getTickContextService: () => ({ getMyRooms: () => Object.values(Game.rooms).filter((r) => r.controller?.my) }),
  getCreepConfigService: () => ({
    get: (name: string) => Memory.data?.creepConfigs?.[name], list: () => Memory.data?.creepConfigs ?? {},
    remove: (name: string) => { delete Memory.data!.creepConfigs![name]; },
    upsert: (name: string, role: CreepConfig["role"], args: string[], roomName: string) => {
      (Memory.data!.creepConfigs ??= {})[name] = { role, args, roomName };
    },
  }),
}));
function deposit(): Deposit {
  return { id: "d1", pos: { x: 20, y: 20, roomName: "E10N1" }, depositType: RESOURCE_METAL,
    cooldown: 0, lastCooldown: 0, ticksToDecay: 5_000 } as unknown as Deposit;
}
beforeEach(() => {
  jest.clearAllMocks(); Game.time = 100; Memory.cfg = {}; Memory.data = { creepConfigs: {} }; Memory.creeps = {};
  Game.creeps = {};
  const store = { getFreeCapacity: () => 1_000 };
  const source = { name: "E1N1", controller: { my: true }, energyAvailable: 3_000, energyCapacityAvailable: 3_000,
    storage: { id: "storage", pos: { x: 25, y: 25, roomName: "E1N1" }, store } } as unknown as Room;
  Game.rooms = { E1N1: source, E10N1: { name: "E10N1" } as Room };
  Game.spawns = { Spawn1: { room: source, pos: { x: 24, y: 25, roomName: "E1N1" }, memory: { spawnList: [] },
    isActive: () => true } as unknown as StructureSpawn };
  Game.map = { findRoute: () => [{ room: "E10N1", exit: FIND_EXIT_RIGHT }] } as unknown as GameMap;
  Game.getObjectById = jest.fn(() => deposit()) as unknown as typeof Game.getObjectById;
  jest.mocked(isDepositRoomSafe).mockReturnValue(true);
  jest.mocked(measureDepositTravel).mockReturnValue({ status: "ready", pathDistance: 100,
    outboundTravelTicks: 100, returnTravelTicks: 100, harvestPos: { x: 19, y: 20, roomName: "E10N1" } });
  recordDepositDiscovery(deposit());
});
describe("Deposit 一代owner与孵化门", () => {
  it("只在完整路径ready后创建spawnOnce，并以实际出生绑定任务", () => {
    runDepositHarvest();
    const task = Memory.data!.depositHarvest!.d1; const cfg = Memory.data!.creepConfigs![task.configName!];
    expect(cfg.spawnOnce).toEqual({}); expect(cfg.body).toHaveLength(40);
    expect(canSpawnDepositConfig(task.configName!, cfg)).toBe(true);
    cfg.spawnOnce!.queuedAt = Game.time;
    Game.time += 1; runDepositHarvest();
    expect(task.bornAt).toBeUndefined(); expect(task.spawnStartedAt).toBeUndefined();
    Game.creeps.d = { name: "d", memory: { configName: task.configName }, spawning: false } as unknown as Creep;
    Game.time += 1; runDepositHarvest();
    expect(task.bornAt).toBe(Game.time); expect(Game.creeps.d.memory.taskId).toBe("d1");
    expect(Memory.data!.creepConfigs![task.configName!]).toBeUndefined();
    delete Game.creeps.d; Game.time += 1; runDepositHarvest();
    expect(task.status).toBe("failed");
    recordDepositDiscovery(deposit()); runDepositHarvest();
    expect(task.status).toBe("failed"); expect(Object.keys(Memory.data!.creepConfigs!)).toHaveLength(0);
  });
  it("pending/失去fresh证据不会放行queuedAt孵化", () => {
    runDepositHarvest(); const task = Memory.data!.depositHarvest!.d1;
    const cfg = Memory.data!.creepConfigs![task.configName!];
    jest.mocked(measureDepositTravel).mockReturnValue({ status: "pending", reason: "path_incomplete", retryAt: 110 });
    Game.time += 1; runDepositHarvest();
    expect(canSpawnDepositConfig(task.configName!, cfg)).toBe(false);
  });
  it("actual queue deadline不能用queuedAt当已出生，超期清owner", () => {
    runDepositHarvest(); const task = Memory.data!.depositHarvest!.d1;
    task.expiresAt = Game.time + 500;
    Memory.data!.creepConfigs!.blocking = { role: "worker", args: [], body: Array(50).fill(WORK) };
    Game.spawns.Spawn1.memory.spawnList = ["blocking", "blocking", "blocking", task.configName!];
    Game.time += 1; runDepositHarvest();
    expect(task.status).toBe("aborted");
    expect(Game.spawns.Spawn1.memory.spawnList).not.toContain(task.configName);
    expect(Memory.data!.creepConfigs![task.configName!]).toBeUndefined();
  });
  it("PB active来源优先；Deposit不借同源Spawn", () => {
    Memory.data!.powerBankHarvest = { p: { sourceRoom: "E1N1", status: "travelling" } as PowerBankHarvestTask };
    runDepositHarvest(); expect(Memory.data!.depositHarvest!.d1.status).toBe("discovered");
    expect(Object.keys(Memory.data!.creepConfigs!)).toHaveLength(0);
  });
  it("孤立owner不会经generic补产", () => {
    Memory.data!.creepConfigs!.orphan = { role: "depositHarvester", args: ["gone"], roomName: "E1N1", taskId: "gone", spawnOnce: {} };
    Game.spawns.Spawn1.memory.spawnList = ["orphan"];
    Memory.cfg!.depositHarvest = { enabled: false };
    runDepositHarvest();
    expect(Memory.data!.creepConfigs!.orphan).toBeUndefined(); expect(Game.spawns.Spawn1.memory.spawnList).toEqual([]);
  });
});


it("新鲜 Deposit 视野可延长到期时间，不复活终态", () => {
  const task = Memory.data!.depositHarvest!.d1;
  task.status = "failed";
  task.expiresAt = Game.time + 10;
  recordDepositDiscovery(deposit());
  expect(task.expiresAt).toBe(Game.time + 5_000);
  expect(task.status).toBe("failed");
});
