import { bootstrapRooms } from "@/runtime/bootstrap";
import { getCreepConfigService } from "@/runtime/runtimeServices";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createSource(id: string, roomName: string, hasLink = false): Source {
  return {
    id,
    room: { name: roomName } as Room,
    pos: {
      findInRange: () => (hasLink ? ([{ structureType: STRUCTURE_LINK }] as StructureLink[]) : []),
      findClosestByRange: (targets: StructureLink[]) => targets[0] || null,
    } as unknown as RoomPosition,
  } as Source;
}

function createMineral(
  id: string,
  options: { hasExtractor?: boolean; hasContainer?: boolean; amount?: number; mineralType?: MineralConstant } = {},
): Mineral {
  const structures: Structure[] = [];
  if (options.hasExtractor) structures.push({ structureType: STRUCTURE_EXTRACTOR } as StructureExtractor);
  if (options.hasContainer) structures.push({ structureType: STRUCTURE_CONTAINER } as StructureContainer);
  return {
    id,
    mineralAmount: options.amount ?? 1000,
    mineralType: options.mineralType ?? RESOURCE_UTRIUM,
    pos: { findInRange: () => structures } as unknown as RoomPosition,
  } as Mineral;
}

function createRoom(options: {
  name?: string;
  level?: number;
  sources?: Source[];
  minerals?: Mineral[];
  constructionCount?: number;
  structures?: Structure[];
  constructionSites?: ConstructionSite[];
} = {}): Room {
  const name = options.name ?? "W1N1";
  const memory = {} as RoomMemory;
  Memory.rooms[name] = memory;
  const sources = options.sources ?? [];
  const minerals = options.minerals ?? [];
  const structures = options.structures ?? [];
  const constructionSites = options.constructionSites ?? Array.from(
    { length: options.constructionCount ?? 0 },
    (_, index) => ({ id: `site-${index}` }),
  ) as ConstructionSite[];
  return {
    name,
    memory,
    controller: { my: true, level: options.level ?? 5 } as StructureController,
    find(type: FindConstant) {
      if (type === FIND_SOURCES) return sources;
      if (type === FIND_CONSTRUCTION_SITES) return constructionSites;
      if (type === FIND_STRUCTURES) return structures;
      if (type === FIND_MINERALS) return minerals;
      return [];
    },
  } as Room;
}

function createSpawn(room: Room, queue: string[] = []): StructureSpawn {
  return { room, memory: { spawnList: [...queue] } } as StructureSpawn;
}

function createOwnedStructure(structureType: StructureConstant): Structure {
  return { structureType, my: true } as unknown as Structure;
}

function createConstructionSite(structureType: BuildableStructureConstant): ConstructionSite {
  return { structureType, my: true } as ConstructionSite;
}

function createRoomPlannerEntry(layout: Record<string, { x: number; y: number }[]>) {
  return { layout, timestamp: "test-plan", savedAt: Game.time };
}

describe("bootstrapRooms", () => {
  beforeEach(() => {
    resetRuntimeServices();
    Game.time += 1;
  });

  it("upserts exact managed payloads and removes stale source queue entries", () => {
    const room = createRoom({
      sources: [createSource("source-a", "W1N1"), createSource("source-b", "W1N1", true)],
      minerals: [createMineral("mineral-a", { hasExtractor: true, hasContainer: true, amount: 2000 })],
    });
    const spawn = createSpawn(room, [
      "W1N1:harvester:old",
      "W1N1:miner:source-b",
      "W1N1:mineralHarvester:old",
      "manual:keep",
    ]);
    Game.rooms[room.name] = room;
    Game.spawns.Spawn1 = spawn;

    bootstrapRooms();

    expect(getCreepConfigService().get("W1N1:harvester:source-a")).toEqual({
      role: "harvester",
      args: ["source-a"],
      roomName: "W1N1",
    });
    expect(getCreepConfigService().get("W1N1:miner:source-b")).toEqual({
      role: "miner",
      args: ["source-b"],
      roomName: "W1N1",
    });
    expect(getCreepConfigService().get("W1N1:mineralHarvester:mineral-a")).toEqual({
      role: "mineralHarvester",
      args: ["mineral-a"],
      roomName: "W1N1",
    });
    expect(getCreepConfigService().get("W1N1:carrier:0")?.roomName).toBe("W1N1");
    expect(getCreepConfigService().get("W1N1:worker:0")?.roomName).toBe("W1N1");
    expect(spawn.memory.spawnList).toEqual(["W1N1:miner:source-b", "manual:keep"]);
  });

  it("orphans a live surplus worker, clears every queue, then deletes it after the creep is gone", () => {
    const room = createRoom({ name: "W8N8", level: 8, constructionCount: 20 });
    const spawnA = createSpawn(room, ["W8N8:worker:1", "manual:keep-a"]);
    const spawnB = createSpawn(room, ["manual:keep-b", "W8N8:worker:1"]);
    Game.rooms[room.name] = room;
    Game.spawns.Spawn1 = spawnA;
    Game.spawns.Spawn2 = spawnB;
    Memory.data = {
      creepConfigs: {
        "W8N8:worker:0": { role: "worker", args: [], roomName: "W8N8" },
        "W8N8:worker:1": { role: "worker", args: [], roomName: "W8N8" },
      },
    } as Memory["data"];
    Game.creeps.workerLive = {
      name: "workerLive",
      room,
      memory: { role: "worker", configName: "W8N8:worker:1" },
      suicide: jest.fn(() => OK),
    } as unknown as Creep;

    bootstrapRooms();

    expect(getCreepConfigService().get("W8N8:worker:0")?.roomName).toBe("W8N8");
    expect(getCreepConfigService().get("W8N8:worker:1")?.roomName).toBeUndefined();
    expect(spawnA.memory.spawnList).toEqual(["manual:keep-a"]);
    expect(spawnB.memory.spawnList).toEqual(["manual:keep-b"]);
    expect(Game.creeps.workerLive.suicide).not.toHaveBeenCalled();

    delete Game.creeps.workerLive;
    Game.time += 1;
    bootstrapRooms();
    expect(getCreepConfigService().get("W8N8:worker:1")).toBeUndefined();
  });

  it("orphans a live mineral harvester and clears its replacement queue when native stock is over the buffer", () => {
    const room = createRoom({
      minerals: [createMineral("mineral-x", {
        hasExtractor: true,
        hasContainer: true,
        mineralType: RESOURCE_CATALYST,
      })],
    });
    room.storage = {
      store: { getUsedCapacity: () => 2_942_223 },
    } as unknown as StructureStorage;
    const configName = "W1N1:mineralHarvester:mineral-x";
    const spawn = createSpawn(room, [configName, "manual:keep"]);
    Game.rooms[room.name] = room;
    Game.spawns.Spawn1 = spawn;
    Memory.data = {
      creepConfigs: {
        [configName]: { role: "mineralHarvester", args: ["mineral-x"], roomName: room.name },
      },
    } as Memory["data"];
    Game.creeps.mineralLive = {
      name: "mineralLive",
      room,
      memory: { role: "mineralHarvester", configName },
    } as unknown as Creep;

    bootstrapRooms();

    expect(getCreepConfigService().get(configName)?.roomName).toBeUndefined();
    expect(spawn.memory.spawnList).toEqual(["manual:keep"]);

    delete Game.creeps.mineralLive;
    Game.time += 1;
    bootstrapRooms();
    expect(getCreepConfigService().get(configName)).toBeUndefined();
  });

  it("fails closed for reserved room types while RESERVE flags drain only worker ownership", () => {
    Memory.cfg = { rooms: { W1N1: { type: "reserved" } } };
    const reservedRoom = createRoom({ name: "W1N1", sources: [createSource("reserved-source", "W1N1")] });
    const reserveFlagRoom = createRoom({
      name: "W5N5",
      level: 5,
      sources: [createSource("source-a", "W5N5")],
      constructionCount: 20,
    });
    reserveFlagRoom.memory.workerConstructionTier = 3;
    Game.rooms = { W1N1: reservedRoom, W5N5: reserveFlagRoom };
    Game.spawns.Spawn1 = createSpawn(reservedRoom);
    const reserveSpawn = createSpawn(reserveFlagRoom, ["W5N5:worker:0", "manual:keep"]);
    Game.spawns.Spawn2 = reserveSpawn;
    Game.flags.RESERVE_W5N5 = {
      name: "RESERVE_W5N5",
      pos: { roomName: reserveFlagRoom.name } as RoomPosition,
    } as Flag;
    Memory.data = {
      creepConfigs: {
        "W5N5:worker:0": { role: "worker", args: [], roomName: reserveFlagRoom.name },
      },
    } as Memory["data"];
    Game.creeps.workerLive = {
      name: "workerLive",
      room: reserveFlagRoom,
      memory: { role: "worker", configName: "W5N5:worker:0" },
      suicide: jest.fn(() => OK),
    } as unknown as Creep;

    bootstrapRooms();

    expect(getCreepConfigService().get("W1N1:harvester:reserved-source")).toBeUndefined();
    expect(getCreepConfigService().get("W5N5:worker:0")?.roomName).toBeUndefined();
    expect(getCreepConfigService().get("W5N5:harvester:source-a")?.roomName).toBe("W5N5");
    expect(getCreepConfigService().get("W5N5:carrier:0")?.roomName).toBe("W5N5");
    expect(reserveSpawn.memory.spawnList).toEqual(["manual:keep"]);
    expect(Game.creeps.workerLive.suicide).not.toHaveBeenCalled();
  });

  it("keeps colony source assistance until the planned RCL3 extension boundary is complete", () => {
    const structures = Array.from({ length: 9 }, () => createOwnedStructure(STRUCTURE_EXTENSION));
    const constructionSites = [createConstructionSite(STRUCTURE_EXTENSION)];
    const room = createRoom({
      name: "W1N1",
      level: 3,
      sources: [createSource("source-a", "W1N1")],
      structures,
      constructionSites,
    });
    Game.rooms[room.name] = room;
    Game.spawns.Spawn1 = createSpawn(room);
    Memory.data = {
      colonization: {
        W1N1: {
          targetRoom: "W1N1",
          sourceRoom: "W9N9",
          status: "managed",
          flagName: "CL",
          planReady: true,
          claimCompleted: true,
          scoutSafe: true,
          dangerousRooms: [],
          createdAt: Game.time,
          updatedAt: Game.time,
        },
      },
      roomPlanner: {
        W1N1: createRoomPlannerEntry({
          [STRUCTURE_EXTENSION]: Array.from({ length: 10 }, (_, index) => ({ x: 10 + index, y: 10 })),
        }),
      },
    } as unknown as Memory["data"];

    bootstrapRooms();
    expect(getCreepConfigService().get("W1N1:harvester:source-a")).toBeUndefined();

    structures.push(createOwnedStructure(STRUCTURE_EXTENSION));
    constructionSites.splice(0);
    Game.time += 1;
    bootstrapRooms();
    expect(getCreepConfigService().get("W1N1:harvester:source-a")).toMatchObject({
      role: "harvester",
      args: ["source-a"],
      roomName: "W1N1",
    });
  });
});
