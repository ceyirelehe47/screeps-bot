jest.mock("@/modules/autoplanner", () => ({
  runPlannerForRoom: jest.fn(() => false),
  savePlannerForRoom: jest.fn(() => false),
}));

jest.mock("@/runtime/warControl", () => ({
  clearWarRoomTask: jest.fn(),
  isWarRoomClearDone: jest.fn(() => false),
  requestWarRoomClear: jest.fn(),
}));

jest.mock("@/runtime/defenseMode", () => ({
  isDefenseMode: jest.fn(() => false),
}));

import { runColonizationByFlag, isColonizationBootstrapRoom } from "@/runtime/colonization";
import { isDefenseMode } from "@/runtime/defenseMode";
import { getCreepConfigService } from "@/runtime/runtimeServices";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

class MockRoomPosition {
  constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}
}

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createSourceRoom(name: string): Room {
  const memory = {} as RoomMemory;
  Memory.rooms[name] = memory;
  return {
    name,
    memory,
    energyCapacityAvailable: 1000,
    controller: {
      my: true,
      level: 5,
    } as StructureController,
    find: jest.fn(() => []),
  } as unknown as Room;
}



function createSpawn(room: Room): StructureSpawn {
  return {
    room,
    pos: {} as RoomPosition,
    owner: {
      username: "me",
    } as Owner,
    memory: {
      spawnList: [],
    },
    isActive: jest.fn(() => true),
    addTask: jest.fn(),
  } as unknown as StructureSpawn;
}





let scenarioTick = 1_000;
describe("runColonizationByFlag", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetRuntimeServices();
    Game.time = ++scenarioTick;
    Memory.data = undefined;
    Game.flags = {}; Game.creeps = {}; Game.spawns = {}; Game.rooms = {};
    (isDefenseMode as jest.Mock).mockReturnValue(false);

    Object.assign(Game, {
      map: {
        getRoomLinearDistance: jest.fn(() => 1),
        getRoomStatus: jest.fn(() => ({ status: "normal" })),
        findRoute: jest.fn(() => [{ exit: RIGHT, room: "W1N2" }]),
        describeExits: jest.fn((roomName: string) => {
          if (roomName === "W1N1") {
            return { [RIGHT]: "W1N2" };
          }
          if (roomName === "W1N2") {
            return { [LEFT]: "W1N1" };
          }
          return null;
        }),
      },
    });

    Object.assign(global, {
      RoomPosition: MockRoomPosition,
      PathFinder: {
        search: jest.fn(() => ({ incomplete: false, path: [{}, {}] })),
        CostMatrix: class {},
      },
    });
  });

  it("母房防御只暂停，目标房新 spawn 不触发换源或自杀", () => {
    const source = createSourceRoom("W1N1"), target = createSourceRoom("W1N2"), other = createSourceRoom("W3N3");
    Game.rooms = { W1N1: source, W1N2: target, W3N3: other };
    Game.spawns = { A: createSpawn(source), B: createSpawn(target), C: createSpawn(other) };
    Game.flags = { CL: { name: "CL", pos: { roomName: "W1N2" }, remove: jest.fn() } as unknown as Flag };
    const name = "W1N1:colonize:W1N2:worker:0";
    const creep = { name: "helper", room: target, memory: { configName: name, role: "colonizerWorker" }, suicide: jest.fn() } as unknown as Creep;
    Game.creeps = { helper: creep };
    Memory.data = { colonization: { W1N2: { targetRoom: "W1N2", sourceRoom: "W1N1", status: "bootstrapping",
      flagName: "CL", planReady: true, claimCompleted: true, createdAt: Game.time, updatedAt: Game.time } },
      creepConfigs: { [name]: { role: "colonizerWorker", roomName: "W1N1", args: ["W1N2"] } } };
    jest.mocked(isDefenseMode).mockImplementation(room => room === "W1N1");
    runColonizationByFlag();
    expect(Memory.data!.colonization!.W1N2.sourceRoom).toBe("W1N1");
    expect(creep.suicide).not.toHaveBeenCalled();
  });
  it("未显式指定母房且持续阻塞500 tick 后改选可用来源", () => {
    const source = createSourceRoom("W1N1"), other = createSourceRoom("W3N3");
    Game.rooms = { W1N1: source, W3N3: other }; Game.creeps = {};
    Game.spawns = { A: createSpawn(source), B: createSpawn(other) };
    Game.flags = { CL: { name: "CL", pos: { roomName: "W1N2" }, remove: jest.fn() } as unknown as Flag };
    Memory.data = { colonization: { W1N2: { targetRoom: "W1N2", sourceRoom: "W1N1", status: "claiming",
      flagName: "CL", planReady: false, claimCompleted: false, sourceBlockedSince: Game.time - 500,
      createdAt: Game.time - 600, updatedAt: Game.time - 1 } } };
    jest.mocked(isDefenseMode).mockImplementation(name => name === source.name);
    runColonizationByFlag();
    expect(Memory.data!.colonization!.W1N2.sourceRoom).toBe(other.name);
    expect(Memory.data!.colonization!.W1N2.sourceBlockedSince).toBeUndefined();
  });

  it.each(["bootstrapping", "managed"] as const)("%s 已承诺支援在 RESERVE 超过500 tick仍保留母房和配置", status => {
    const source = createSourceRoom("W1N1"), target = createSourceRoom("W1N2"), other = createSourceRoom("W3N3");
    Game.rooms = { W1N1: source, W1N2: target, W3N3: other };
    Game.spawns = { A: createSpawn(source), B: createSpawn(other) }; Game.creeps = {};
    Game.flags = { CL: { name: "CL", pos: { roomName: target.name }, remove: jest.fn() } as unknown as Flag,
      RESERVE_W1N1: { name: "RESERVE_W1N1", pos: { roomName: source.name } } as Flag };
    const name = `${source.name}:colonize:${target.name}:worker:0`;
    Memory.data = { colonization: { W1N2: { targetRoom: target.name, sourceRoom: source.name, status,
      flagName: "CL", planReady: true, claimCompleted: true, sourceBlockedSince: Game.time - 600,
      createdAt: Game.time - 700, updatedAt: Game.time - 1 } },
      creepConfigs: { [name]: { role: "colonizerWorker", roomName: source.name, args: [target.name] } } };
    runColonizationByFlag();
    expect(Memory.data!.colonization!.W1N2.sourceRoom).toBe(source.name);
    expect(Memory.data!.colonization!.W1N2.sourceBlockedSince).toBeUndefined();
    expect(getCreepConfigService().get(name)?.roomName).toBe(source.name);
  });

  it("已在途的 claimer 不因母房 RESERVE 超过500 tick被换源重复孵化", () => {
    const source = createSourceRoom("W1N1"), other = createSourceRoom("W3N3");
    Game.rooms = { W1N1: source, W3N3: other };
    Game.spawns = { A: createSpawn(source), B: createSpawn(other) };
    Game.flags = { CL: { name: "CL", pos: { roomName: "W1N2" }, remove: jest.fn() } as unknown as Flag,
      RESERVE_W1N1: { name: "RESERVE_W1N1", pos: { roomName: source.name } } as Flag };
    const name = "W1N1:colonize:W1N2:claimer:0";
    Game.creeps = { claimer: { name: "claimer", memory: { configName: name, role: "claimer" }, room: source } as unknown as Creep };
    Memory.data = { colonization: { W1N2: { targetRoom: "W1N2", sourceRoom: source.name, status: "claiming",
      flagName: "CL", planReady: false, claimCompleted: false, sourceBlockedSince: Game.time - 600,
      createdAt: Game.time - 700, updatedAt: Game.time - 1 } },
      creepConfigs: { [name]: { role: "claimer", roomName: source.name, args: ["W1N2"] } } };
    runColonizationByFlag();
    expect(Memory.data!.colonization!.W1N2.sourceRoom).toBe(source.name);
    expect(Memory.data!.colonization!.W1N2.sourceBlockedSince).toBeUndefined();
    expect(getCreepConfigService().get(name)?.roomName).toBe(source.name);
  });

  it("reuses a failed safe-route lookup within the same tick", () => {
    const sourceRoom = createSourceRoom("W1N1");
    const spawn = createSpawn(sourceRoom);

    Game.rooms[sourceRoom.name] = sourceRoom;
    Game.spawns.Spawn1 = spawn;
    Game.flags.CL = {
      name: "CL",
      pos: {
        roomName: "W1N2",
      } as RoomPosition,
      remove: jest.fn(),
    } as unknown as Flag;

    (Game.map.findRoute as jest.Mock).mockReturnValue(ERR_NO_PATH);
    Memory.data = {
      colonization: {
        W1N2: {
          targetRoom: "W1N2",
          sourceRoom: "W1N1",
          status: "claiming",
          flagName: "CL",
          planReady: false,
          claimCompleted: false,
          scoutSafe: false,
          scoutRouteRooms: ["W1N1", "W9N9", "W1N2"],
          dangerousRooms: [],
          createdAt: Game.time,
          updatedAt: Game.time,
        },
      },
    } as Memory["data"];

    runColonizationByFlag();

    expect(Game.map.findRoute).toHaveBeenCalledTimes(1);
  });

  it("detaches colonization configs immediately when the flag is removed while creeps are alive", () => {
    const sourceRoom = createSourceRoom("W1N1");
    const spawn = createSpawn(sourceRoom);
    const workerConfigName = "W1N1:colonize:W1N2:worker:0";
    const workerMemory = {
      role: "colonizerWorker",
      configName: workerConfigName,
    } as CreepMemory;
    const workerSuicide = jest.fn(() => OK);

    Game.rooms[sourceRoom.name] = sourceRoom;
    Game.spawns.Spawn1 = spawn;
    Game.flags = {};
    spawn.memory.spawnList = [workerConfigName];
    Memory.creeps.colonizerWorker = workerMemory;
    Game.creeps.colonizerWorker = {
      name: "colonizerWorker",
      room: sourceRoom,
      memory: workerMemory,
      owner: {
        username: "me",
      } as Owner,
      suicide: workerSuicide,
    } as unknown as Creep;
    Memory.data = {
      colonization: {
        W1N2: {
          targetRoom: "W1N2",
          sourceRoom: "W1N1",
          status: "bootstrapping",
          flagName: "CL",
          planReady: true,
          claimCompleted: true,
          scoutSafe: true,
          scoutRouteRooms: ["W1N1", "W1N2"],
          dangerousRooms: [],
          createdAt: Game.time,
          updatedAt: Game.time,
        },
      },
      creepConfigs: {
        [workerConfigName]: {
          role: "colonizerWorker",
          args: ["W1N2", "W1N1|W1N2"],
          roomName: "W1N1",
        },
      },
    } as Memory["data"];

    runColonizationByFlag();

    expect(workerSuicide).toHaveBeenCalledTimes(1);
    expect(spawn.memory.spawnList).not.toContain(workerConfigName);
    expect(getCreepConfigService().get(workerConfigName)?.roomName).toBeUndefined();

    delete Game.creeps.colonizerWorker;
    delete Memory.creeps.colonizerWorker;
    Game.time += 1;

    runColonizationByFlag();

    expect(getCreepConfigService().get(workerConfigName)).toBeUndefined();
    expect(Memory.data?.colonization?.W1N2).toBeUndefined();
  });

});


describe("殖民复查回归", () => {
  beforeEach(() => {
    jest.clearAllMocks(); resetRuntimeServices(); Game.time = 20000;
    jest.mocked(isDefenseMode).mockReturnValue(false);
    Game.creeps = {}; Game.rooms = {}; Game.spawns = {}; Game.flags = {};
    Memory.cfg = {}; Memory.runtime = {}; Memory.data = {}; Memory.creeps = {};
    Game.gcl = { level: 20 } as GlobalControlLevel;
    Game.map = { getRoomLinearDistance: jest.fn(() => 1), findRoute: jest.fn(() => ERR_NO_PATH),
      getRoomStatus: jest.fn(() => ({ status: "normal" })), describeExits: jest.fn(() => null) } as unknown as Game["map"];
  });
  function setup(flagName = "CL") {
    const source = createSourceRoom("W1N1"), target = { name: "W1N2", find: () => [] } as unknown as Room;
    const flag = { name: flagName, pos: { roomName: "W1N2" }, remove: jest.fn() } as unknown as Flag;
    Game.rooms = { W1N1: source, W1N2: target }; Game.spawns = { S: createSpawn(source) }; Game.flags = { [flagName]: flag };
    Memory.data = { colonization: { W1N2: { targetRoom: "W1N2", sourceRoom: "W1N1", flagName,
      status: "claiming", planReady: false, claimCompleted: false, scoutSafe: false, createdAt: Game.time, updatedAt: Game.time } } };
    return { source, target, flag };
  }
  it("老任务重新侦察不会按创建时间立即放弃；当前侦察超时后保留旗和活体并暂停补员", () => {
    const { source, flag } = setup();
    Memory.data!.colonization!.W1N2.createdAt = 1;
    const name = "W1N1:colonize:W1N2:scout:0";
    const creep = { name: "scout", room: source, memory: { role: "scout", configName: name }, suicide: jest.fn() } as unknown as Creep;
    Game.creeps = { scout: creep };
    Memory.data!.creepConfigs = { [name]: { role: "scout", roomName: source.name, args: ["W1N2"] } };
    runColonizationByFlag();
    expect(Memory.data!.colonization!.W1N2.scoutStartedAt).toBe(Game.time);
    expect(flag.remove).not.toHaveBeenCalled(); expect(creep.suicide).not.toHaveBeenCalled();
    Game.time += 5000; runColonizationByFlag();
    expect(Memory.data!.colonization!.W1N2.blockedReason).toBe("scout_timeout");
    expect(flag.remove).not.toHaveBeenCalled(); expect(creep.suicide).not.toHaveBeenCalled();
    Game.time++; runColonizationByFlag();
    expect(Memory.data!.creepConfigs![name].roomName).toBeUndefined();
    expect(Game.spawns.S.memory.spawnList).toEqual([]);
  });
  it("claimer 的原生 GCL 失败在冷却结束前保留，阻塞解除后重新计侦察时间", () => {
    setup(); const task = Memory.data!.colonization!.W1N2;
    task.blockedReason = "gcl_not_enough"; task.blockedUntil = Game.time + 500; task.scoutStartedAt = 1;
    runColonizationByFlag();
    expect(Memory.data!.colonization!.W1N2.blockedReason).toBe("gcl_not_enough");
    expect(Memory.data!.colonization!.W1N2.scoutStartedAt).toBeUndefined();
    Game.time += 500; runColonizationByFlag();
    expect(Memory.data!.colonization!.W1N2.blockedReason).toBeUndefined();
    expect(Memory.data!.colonization!.W1N2.scoutStartedAt).toBe(Game.time);
  });
  it("任务已存在时显式 CL_ 母房仍优先于锁定源房", () => {
    setup("CL_W3N3"); const preferred = createSourceRoom("W3N3");
    Game.rooms.W3N3 = preferred; Game.spawns.P = createSpawn(preferred);
    runColonizationByFlag();
    expect(Memory.data!.colonization!.W1N2.sourceRoom).toBe("W3N3");
  });
  it("母房防御时不压制殖民房本地采矿，防御解除后恢复正常支援交接", () => {
    setup(); Memory.data!.colonization!.W1N2.status = "managed";
    jest.mocked(isDefenseMode).mockReturnValue(true);
    expect(isColonizationBootstrapRoom("W1N2")).toBe(false);
    jest.mocked(isDefenseMode).mockReturnValue(false);
    expect(isColonizationBootstrapRoom("W1N2")).toBe(true);
  });

});
