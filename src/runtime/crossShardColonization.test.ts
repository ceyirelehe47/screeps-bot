jest.mock("@/runtime/defenseMode", () => ({
  isDefenseMode: jest.fn(() => false),
}));

import { runCrossShardColonizationByFlag } from "@/runtime/crossShardColonization";
import { isDefenseMode } from "@/runtime/defenseMode";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createRoom(name: string): Room {
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

function createSpawn(name: string, room: Room): StructureSpawn {
  const spawn = {
    name,
    room,
    memory: {
      spawnList: [],
    },
    isActive: jest.fn(() => true),
  } as unknown as StructureSpawn;

  spawn.addTask = jest.fn((configName: string) => {
    if (!spawn.memory.spawnList) {
      spawn.memory.spawnList = [];
    }
    if (!spawn.memory.spawnList.includes(configName)) {
      spawn.memory.spawnList.push(configName);
    }
    return spawn.memory.spawnList.length;
  });

  return spawn;
}


describe("runCrossShardColonizationByFlag", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetRuntimeServices();
    Game.time = 10000;
    Game.rooms = {};
    Game.spawns = {};
    Game.creeps = {};
    Game.flags = {};
    Game.shard = { name: "shard0" } as Game["shard"];
    Memory.data = undefined;
    Memory.rooms = {};
    Memory.creeps = {};
    (isDefenseMode as jest.Mock).mockReturnValue(false);

    Object.assign(Game, {
      map: {
        getRoomLinearDistance: jest.fn(() => 1),
      },
    });
  });

  it("旧占领信号必须等到对端继续推进且重新确认当前所有权", () => {
    let stamp = 500;
    let claimAt = 500;
    Object.assign(global, { InterShardMemory: { getRemote: jest.fn(() => JSON.stringify({ version: 1, shard: "shard1", updatedAt: stamp,
      claims: [{ room: "W9N9", at: claimAt }], rooms: [{ room: "W9N9", at: claimAt, hasSpawn: true }] })) } });
    Memory.data = { crossShardColonization: { "shard1:W9N9": { targetShard: "shard1", targetRoom: "W9N9",
      status: "planning", flagName: "CLX_shard1_W9N9", createdAt: Game.time, updatedAt: Game.time } } };
    runCrossShardColonizationByFlag();
    expect(Memory.data!.crossShardColonization!["shard1:W9N9"].status).toBe("blocked");
    Game.time++; stamp = 1000;
    runCrossShardColonizationByFlag();
    expect(Memory.data!.crossShardColonization!["shard1:W9N9"].status).toBe("blocked");
    Game.time++; stamp++; claimAt = stamp;
    runCrossShardColonizationByFlag();
    expect(Memory.data!.crossShardColonization!["shard1:W9N9"].status).toBe("completed");
  });
  it("enqueues claimer to the least-loaded spawn in a multi-spawn room", () => {
    const sourceRoom = createRoom("W1N1");
    Game.rooms[sourceRoom.name] = sourceRoom;
    const spawnA = createSpawn("SpawnA", sourceRoom);
    spawnA.memory.spawnList = ["existing-task-1", "existing-task-2"];
    const spawnB = createSpawn("SpawnB", sourceRoom);
    Game.spawns.SpawnA = spawnA;
    Game.spawns.SpawnB = spawnB;
    Memory.data = {
      creepConfigs: {},
      interShardPortals: {
        portal1: {
          id: "portal1" as Id<StructurePortal>,
          originRoom: "W1N2",
          destinationShard: "shard1",
          destinationRoom: "W9N8",
          discoveredAt: Game.time,
          lastSeenAt: Game.time,
          ticksToDecay: 10000,
        },
      },
      crossShardColonization: {
        "shard1:W9N9": {
          targetShard: "shard1",
          targetRoom: "W9N9",
          sourceRoom: "W1N1",
          status: "planning",
          flagName: "CLX_shard1_W9N9",
          portalRoom: "W1N2",
          destinationRoom: "W9N8",
          createdAt: Game.time - 100,
          updatedAt: Game.time - 1,
        },
      },
    } as Memory["data"];

    runCrossShardColonizationByFlag();

    const configName = "W1N1:crossShard:shard1:W9N9:claimer:0";
    expect(spawnB.memory.spawnList).toContain(configName);
    expect(spawnA.memory.spawnList).not.toContain(configName);
  });

  it("does not duplicate a claimer already queued on a secondary spawn", () => {
    const sourceRoom = createRoom("W1N1");
    Game.rooms[sourceRoom.name] = sourceRoom;
    const configName = "W1N1:crossShard:shard1:W9N9:claimer:0";
    const spawnA = createSpawn("SpawnA", sourceRoom);
    const spawnB = createSpawn("SpawnB", sourceRoom);
    spawnB.memory.spawnList = [configName];
    Game.spawns.SpawnA = spawnA;
    Game.spawns.SpawnB = spawnB;
    Memory.data = {
      creepConfigs: {},
      interShardPortals: {
        portal1: {
          id: "portal1" as Id<StructurePortal>,
          originRoom: "W1N2",
          destinationShard: "shard1",
          destinationRoom: "W9N8",
          discoveredAt: Game.time,
          lastSeenAt: Game.time,
          ticksToDecay: 10000,
        },
      },
      crossShardColonization: {
        "shard1:W9N9": {
          targetShard: "shard1",
          targetRoom: "W9N9",
          sourceRoom: "W1N1",
          status: "planning",
          flagName: "CLX_shard1_W9N9",
          portalRoom: "W1N2",
          destinationRoom: "W9N8",
          claimerConfigName: configName,
          createdAt: Game.time - 100,
          updatedAt: Game.time - 1,
        },
      },
    } as Memory["data"];

    runCrossShardColonizationByFlag();

    expect(spawnA.memory.spawnList).not.toContain(configName);
    expect(spawnB.memory.spawnList).toContain(configName);
  });
});


it("Portal 旧快照已过期时不能继续排队，并撤销原有待孵化配置", () => {
  resetRuntimeServices(); Game.time = 10000; Game.creeps = {}; Game.flags = {};
  Game.shard = { name: "shard0" } as Game["shard"];
  const room = createRoom("W1N1"), spawn = createSpawn("Spawn", room);
  Game.rooms = { W1N1: room }; Game.spawns = { Spawn: spawn };
  const configName = "W1N1:crossShard:shard1:W9N9:claimer:0";
  spawn.memory.spawnList = [configName];
  Memory.data = { creepConfigs: { [configName]: { role: "crossShardClaimer", args: [], roomName: room.name } },
    interShardPortals: { p: { id: "p", originRoom: "W1N2", destinationShard: "shard1", destinationRoom: "W9N8",
      discoveredAt: 9000, lastSeenAt: 9000, ticksToDecay: 500 } },
    crossShardColonization: { "shard1:W9N9": { targetShard: "shard1", targetRoom: "W9N9", sourceRoom: room.name,
      status: "planning", flagName: "CLX_shard1_W9N9", claimerConfigName: configName, createdAt: 9000, updatedAt: 9000 } } } as any;
  Object.assign(Game, { map: { getRoomLinearDistance: () => 1 } });
  runCrossShardColonizationByFlag();
  expect(spawn.memory.spawnList).not.toContain(configName);
  expect(Memory.data!.crossShardColonization!["shard1:W9N9"].status).toBe("blocked");
});
