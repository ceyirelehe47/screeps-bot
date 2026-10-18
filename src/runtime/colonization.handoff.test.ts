import { requestSpawn } from "@/runtime/spawnRequests";
jest.mock("@/modules/autoplanner", () => ({
  runPlannerForRoom: jest.fn(() => false),
  savePlannerForRoom: jest.fn(() => false),
}));
jest.mock("@/runtime/warControl", () => ({
  clearWarRoomTask: jest.fn(),
  isWarRoomClearDone: jest.fn(() => false),
  requestWarRoomClear: jest.fn(),
}));
jest.mock("@/runtime/defenseMode", () => ({ isDefenseMode: jest.fn(() => false) }));

import { runColonizationByFlag } from "@/runtime/colonization";
import { bootstrapRooms } from "@/runtime/bootstrap";
import { scheduleSpawnTasks } from "@/runtime/spawnPlanner";
import { isDefenseMode } from "@/runtime/defenseMode";
import { getCreepConfigService } from "@/runtime/runtimeServices";

const HOME = "E1N57";
const TARGET = "E3N54";
const FLAG = `CL_${HOME}_${TARGET}`;
const motherConfig = (id: string) => `${HOME}:colonize:${TARGET}:harvester:${id}`;
const localConfig = (id: string) => `${TARGET}:harvester:${id}`;

function nextTick(): void {
  Game.time += 1;
  delete (global as typeof global & { __runtimeServices?: unknown }).__runtimeServices;
}

function seedColony(extensionCount: number) {
  const structures = Array.from({ length: extensionCount }, () => ({
    structureType: STRUCTURE_EXTENSION, my: true,
  }) as StructureExtension);
  const sites = Array.from({ length: 10 - extensionCount }, () => ({
    structureType: STRUCTURE_EXTENSION, my: true,
  }) as ConstructionSite);
  const sources = ["source-a", "source-b"].map((id) => ({
    id: id as Id<Source>,
    pos: {
      x: 12, y: 42, roomName: TARGET,
      findInRange: () => [],
    } as unknown as RoomPosition,
  }) as Source);
  function room(name: string, level: number): Room {
    const memory = {} as RoomMemory;
    Memory.rooms[name] = memory;
    return {
      name, memory,
      energyAvailable: name === HOME ? 12900 : 300,
      energyCapacityAvailable: name === HOME ? 12900 : 300 + extensionCount * 50,
      controller: { my: true, level } as StructureController,
      find(type: FindConstant) {
        if (name !== TARGET) return [];
        if (type === FIND_SOURCES) return sources;
        if (type === FIND_STRUCTURES || type === FIND_MY_STRUCTURES) return structures;
        if (type === FIND_CONSTRUCTION_SITES || type === FIND_MY_CONSTRUCTION_SITES) return sites;
        return [];
      },
    } as Room;
  }
  const home = room(HOME, 8);
  const target = room(TARGET, 3);
  for (const source of sources) source.room = target;
  function spawn(name: string, room: Room): StructureSpawn {
    const result = {
      name, room,
      pos: { x: 25, y: 25, roomName: room.name } as RoomPosition,
      owner: { username: "me" } as Owner,
      memory: { spawnList: [] },
      spawning: null,
      isActive: () => true,
      addTask: jest.fn((configName: string) => {
        requestSpawn(result, configName);
      }),
    } as unknown as StructureSpawn;
    return result;
  }
  const homeSpawn = spawn("MotherSpawn", home);
  const targetSpawn = spawn("ColonySpawn", target);
  Game.rooms = { [HOME]: home, [TARGET]: target };
  Game.spawns = { MotherSpawn: homeSpawn, ColonySpawn: targetSpawn };
  Game.flags = {
    [FLAG]: { name: FLAG, pos: { roomName: TARGET }, remove: jest.fn() } as unknown as Flag,
  };
  Memory.data = {
    creepConfigs: {},
    colonization: {
      [TARGET]: {
        sourceRoom: HOME, targetRoom: TARGET, status: "managed", flagName: FLAG,
        planReady: true, claimCompleted: true, scoutSafe: true,
        scoutRouteRooms: [HOME, TARGET], dangerousRooms: [],
        createdAt: Game.time, updatedAt: Game.time,
      },
    },
    roomPlanner: {
      [TARGET]: {
        timestamp: "fixture", savedAt: Game.time,
        layout: {
          [STRUCTURE_SPAWN]: [{ x: 25, y: 25 }],
          [STRUCTURE_EXTENSION]: Array.from({ length: 10 }, (_, x) => ({ x: 10 + x, y: 10 })),
        },
      },
    },
  } as Memory["data"];
  return { home, target, homeSpawn, targetSpawn, structures, sites };
}

function addCreep(name: string, room: Room, configName: string, spawning = false): Creep {
  const memory = { role: "harvester", configName } as CreepMemory;
  const creep = {
    name, room, memory, spawning, ticksToLive: 1400,
    pos: { x: 12, y: 41, roomName: room.name },
    owner: { username: "me" },
    body: [WORK, CARRY, MOVE].map((type) => ({ type, hits: 100 })),
    suicide: jest.fn(() => OK),
  } as unknown as Creep;
  Memory.creeps[name] = memory;
  Game.creeps[name] = creep;
  return creep;
}

function addLocalMiner(id: string, target: Room, spawning = false): Creep {
  getCreepConfigService().upsert(localConfig(id), "harvester", [id], TARGET);
  return addCreep(`local-${id}`, target, localConfig(id), spawning);
}

describe("殖民矿工与本地生产交接", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Game.creeps = {};
    Memory.creeps = {};
    Memory.cfg = {};
    Memory.runtime = {};
    nextTick();
    (isDefenseMode as jest.Mock).mockReturnValue(false);
  });

  it.each([8, 5])("RCL3 只有 %i 个扩展且支援配置已丢失时，恢复母房矿工和建造队列", (count) => {
    const { homeSpawn } = seedColony(count);
    runColonizationByFlag();
    bootstrapRooms();
    scheduleSpawnTasks();

    for (const id of ["source-a", "source-b"]) {
      expect(getCreepConfigService().get(motherConfig(id))).toMatchObject({
        role: "colonizerHarvester", roomName: HOME, args: [TARGET, id, `${HOME}|${TARGET}`],
      });
      expect(homeSpawn.memory.spawnList).toContain(motherConfig(id));
      expect(getCreepConfigService().get(localConfig(id))).toBeUndefined();
    }
    for (const index of [0, 1]) {
      expect(homeSpawn.memory.spawnList).toContain(`${HOME}:colonize:${TARGET}:worker:${index}`);
    }
    expect(Game.flags[FLAG].remove).not.toHaveBeenCalled();
  });

  it("重绑仍存活的支援矿工配置，不杀死现役矿工", () => {
    const { target } = seedColony(8);
    getCreepConfigService().upsert(motherConfig("source-a"), "colonizerHarvester", [TARGET, "source-a"]);
    const helper = addCreep("mother-a", target, motherConfig("source-a"));
    runColonizationByFlag();
    expect(getCreepConfigService().get(motherConfig("source-a"))?.roomName).toBe(HOME);
    expect(helper.suicide).not.toHaveBeenCalled();
  });

  it("扩展完成后允许本地补产，但本地无人时继续维持母房矿工", () => {
    seedColony(10);
    runColonizationByFlag();
    bootstrapRooms();
    for (const id of ["source-a", "source-b"]) {
      expect(getCreepConfigService().get(motherConfig(id))?.roomName).toBe(HOME);
      expect(getCreepConfigService().get(localConfig(id))?.roomName).toBe(TARGET);
    }
    expect(Game.flags[FLAG].remove).not.toHaveBeenCalled();
  });

  it("本地矿工仍在出生时不撤母房补产或现役矿工", () => {
    const { target, targetSpawn } = seedColony(10);
    const helper = addCreep("mother-a", target, motherConfig("source-a"));
    addLocalMiner("source-a", target, true);
    addLocalMiner("source-b", target, true);
    targetSpawn.spawning = { name: "local-source-a" } as Spawning;
    nextTick();
    runColonizationByFlag();
    expect(helper.suicide).not.toHaveBeenCalled();
    expect(getCreepConfigService().get(motherConfig("source-a"))?.roomName).toBe(HOME);
    expect(getCreepConfigService().get(motherConfig("source-b"))?.roomName).toBe(HOME);
    expect(Game.flags[FLAG].remove).not.toHaveBeenCalled();
  });

  it("按矿点交接，全部本地矿工出生后才清理殖民任务和旗帜", () => {
    const { target } = seedColony(10);
    runColonizationByFlag();
    const helperA = addCreep("mother-a", target, motherConfig("source-a"));
    const helperB = addCreep("mother-b", target, motherConfig("source-b"));
    addLocalMiner("source-a", target);
    nextTick();
    runColonizationByFlag();
    expect(helperA.suicide).toHaveBeenCalledTimes(1);
    expect(helperB.suicide).not.toHaveBeenCalled();
    expect(getCreepConfigService().get(motherConfig("source-a"))).toBeUndefined();
    expect(getCreepConfigService().get(motherConfig("source-b"))?.roomName).toBe(HOME);
    expect(Game.flags[FLAG].remove).not.toHaveBeenCalled();

    delete Game.creeps[helperA.name];
    addLocalMiner("source-b", target);
    nextTick();
    runColonizationByFlag();
    expect(helperB.suicide).toHaveBeenCalledTimes(1);
    expect(Memory.data?.colonization?.[TARGET]).toBeUndefined();
    expect(Game.flags[FLAG].remove).toHaveBeenCalledTimes(1);
    expect(getCreepConfigService().list(`${HOME}:colonize:${TARGET}:`)).toEqual({});
  });

  it("母房处于防御模式时仍暂停支援，不绕过原有安全门", () => {
    seedColony(8);
    (isDefenseMode as jest.Mock).mockImplementation((roomName: string) => roomName === HOME);
    runColonizationByFlag();
    expect(getCreepConfigService().list(`${HOME}:colonize:${TARGET}:`)).toEqual({});
  });
});
