import { getSafeZone } from "@/runtime/safeZone";
import { resetRuntimeIsolationForTest } from "@/runtime/runtimeIsolation";
jest.mock("@/runtime/safeZone", () => ({
  getSafeZone: jest.fn(() => new Set(["safe"])),
}));

jest.mock("@/runtime/boostControl", () => ({
  clearBoostLabTasks: jest.fn(),
  syncBoostLabTask: jest.fn(),
  buyBoostIfNeeded: jest.fn(),
  shouldBoostDefender: jest.fn(() => true),
}));

import { runHomeDefense, runHomeDefenseSupply } from "@/runtime/homeDefense";
import { getRoomDefenseCoordination } from "@/runtime/defenseCoordination";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

class MockPos {
  public constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}

  public getRangeTo(target: { pos?: { x: number; y: number }; x?: number; y?: number }): number {
    const targetPos = "pos" in target && target.pos ? target.pos : target;
    return Math.max(Math.abs(this.x - (targetPos.x ?? 0)), Math.abs(this.y - (targetPos.y ?? 0)));
  }
}

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createTower(roomName: string, x: number, y: number, energy: number): StructureTower {
  return {
    id: `${roomName}-tower-${x}-${y}` as Id<StructureTower>,
    structureType: STRUCTURE_TOWER,
    pos: new MockPos(x, y, roomName) as unknown as RoomPosition,
    store: {
      getCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY || resource === undefined ? 1000 : 0)),
      getFreeCapacity: jest.fn((resource?: ResourceConstant) =>
        resource === RESOURCE_ENERGY || resource === undefined ? Math.max(0, 1000 - energy) : 0,
      ),
      getUsedCapacity: jest.fn((resource?: ResourceConstant) => (resource === RESOURCE_ENERGY || resource === undefined ? energy : 0)),
    } as unknown as StoreDefinition,
  } as unknown as StructureTower;
}

function createHostile(roomName: string, x: number, y: number): Creep {
  return {
    id: `${roomName}-hostile-${x}-${y}` as Id<Creep>,
    owner: {
      username: "Enemy",
    } as Owner,
    pos: new MockPos(x, y, roomName) as unknown as RoomPosition,
    body: [{ type: ATTACK, hits: 100 } as BodyPartDefinition],
    hits: 100,
    hitsMax: 100,
    getActiveBodyparts: jest.fn((part: BodyPartConstant) => (part === ATTACK ? 1 : 0)),
  } as unknown as Creep;
}

function createRoom(
  name: string,
  options: {
    towers?: StructureTower[];
    hostiles?: Creep[];
    myCreeps?: Creep[];
  } = {},
): Room {
  const towers = options.towers ?? [];
  const hostiles = options.hostiles ?? [];
  const myCreeps = options.myCreeps ?? [];

  const hostileFilter = (opts?: { filter?: unknown }): ((creep: Creep) => boolean) | null => {
    if (typeof opts?.filter === "function") {
      return opts.filter as (creep: Creep) => boolean;
    }

    return null;
  };

  return {
    name,
    controller: {
      my: true,
    } as StructureController,
    find(type: FindConstant, opts?: { filter?: unknown }) {
      if (type === FIND_HOSTILE_CREEPS) {
        const results = [...hostiles];
        const filter = hostileFilter(opts);
        return filter ? results.filter((creep) => filter(creep)) : results;
      }

      if (type === FIND_MY_STRUCTURES) {
        return towers;
      }

      if (type === FIND_MY_CREEPS) {
        return myCreeps;
      }

      return [];
    },
  } as Room;
}

function createSpawn(room: Room, queue: string[] = []): StructureSpawn {
  return {
    name: `${room.name}-spawn`,
    id: `${room.name}-spawn-id` as Id<StructureSpawn>,
    room,
    memory: {
      spawnList: [...queue],
    },
    spawning: null,
    addTask(configName: string) {
      this.memory.spawnList = [...(this.memory.spawnList || []), configName];
      return this.memory.spawnList.length;
    },
  } as unknown as StructureSpawn;
}

describe("runHomeDefense", () => {
  beforeEach(() => {
    resetRuntimeServices();
    resetRuntimeIsolationForTest();
    jest.clearAllMocks();
    Game.time += 1;
  });

  it("首房防御异常后其余房间继续创建防御配置", () => {
    const bad = createRoom("W1N1"), good = createRoom("W2N2", { hostiles: [createHostile("W2N2", 20, 20)] });
    Game.rooms = { W1N1: bad, W2N2: good };
    const spawn = createSpawn(good); Game.spawns = { [spawn.name]: spawn };
    (getSafeZone as jest.Mock).mockImplementationOnce(() => { throw new Error("safe-zone fault"); });
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      runHomeDefense();
      expect(spawn.memory.spawnList?.some(name => name.includes(good.name))).toBe(true);
      expect(log).toHaveBeenCalledTimes(1);
    } finally { log.mockRestore(); }
  });

  it("assigns primary and secondary roles when one front needs multiple defenders", () => {
    const roomName = "W2N2";
    const room = createRoom(roomName, {
      towers: [createTower(roomName, 25, 25, 0)],
      hostiles: [
        createHostile(roomName, 10, 10),
        createHostile(roomName, 12, 10),
        createHostile(roomName, 14, 10),
      ],
    });
    const spawn = createSpawn(room);
    Game.rooms[room.name] = room;
    Game.spawns[spawn.name] = spawn;

    runHomeDefense();

    expect(spawn.memory.spawnList).toEqual([
      `${roomName}:homeDefense:defender:0`,
      `${roomName}:homeDefense:defender:1`,
    ]);
    expect(getRoomDefenseCoordination(roomName)).toMatchObject({
      defenderAssignments: {
        "0": "front:0",
        "1": "front:0",
      },
      defenderRoles: {
        "0": "primary",
        "1": "secondary",
      },
    });
  });

  describe("multi-spawn queue cleanup", () => {
    it("removes defender configs from all room spawns when hostiles leave", () => {
      const roomName = "W3N1";
      const defender0 = `${roomName}:homeDefense:defender:0`;
      const defender1 = `${roomName}:homeDefense:defender:1`;
      const unrelatedConfig = `${roomName}:worker:0`;

      const hostile = createHostile(roomName, 12, 12);
      const room = createRoom(roomName, {
        towers: [createTower(roomName, 25, 25, 0)],
        hostiles: [hostile],
      });

      const spawnA = createSpawn(room, [unrelatedConfig]);
      spawnA.name = `${roomName}-spawnA`;
      const spawnB = createSpawn(room, [`${roomName}:carrier:0`, defender1]);
      spawnB.name = `${roomName}-spawnB`;

      Game.rooms[room.name] = room;
      Game.spawns[spawnA.name] = spawnA;
      Game.spawns[spawnB.name] = spawnB;
      Memory.data = {
        creepConfigs: {},
      } as Memory["data"];

      runHomeDefense();

      expect(spawnA.memory.spawnList).toContain(defender0);

      const roomNoHostiles = createRoom(roomName, {
        towers: [createTower(roomName, 25, 25, 500)],
      });
      Game.rooms[roomName] = roomNoHostiles;
      resetRuntimeServices();

      runHomeDefense();

      expect(spawnA.memory.spawnList).not.toContain(defender0);
      expect(spawnA.memory.spawnList).not.toContain(defender1);
      expect(spawnB.memory.spawnList).not.toContain(defender0);
      expect(spawnB.memory.spawnList).not.toContain(defender1);
      expect(spawnA.memory.spawnList).toContain(unrelatedConfig);
      expect(spawnB.memory.spawnList).toContain(`${roomName}:carrier:0`);
    });
  });
});


it("确需强化的防御任务连接 boost 补给与购买入口", () => {
  resetRuntimeServices(); Game.time += 1;
  const room = createRoom("W6N6", { hostiles: [createHostile("W6N6", 20, 20)] });
  Game.rooms = { W6N6: room }; const spawn = createSpawn(room); Game.spawns = { Spawn: spawn };
  Memory.cfg = { homeDefense: { rooms: { W6N6: { boostLabId: "boost-lab" } } } };
  runHomeDefense();
  const { syncBoostLabTask, buyBoostIfNeeded } = jest.requireMock("@/runtime/boostControl");
  expect(buyBoostIfNeeded).not.toHaveBeenCalled();
  runHomeDefenseSupply();
  expect(syncBoostLabTask).toHaveBeenCalledWith(room);
  expect(buyBoostIfNeeded).toHaveBeenCalledWith(room);
});
