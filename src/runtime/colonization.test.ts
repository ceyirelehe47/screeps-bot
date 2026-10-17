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

import { runColonizationByFlag } from "@/runtime/colonization";
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





describe("runColonizationByFlag", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetRuntimeServices();
    Game.time += 1;
    Memory.data = undefined;
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
