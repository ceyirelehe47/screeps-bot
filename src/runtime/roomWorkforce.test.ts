import {
  applyRoomWorkforceConstructionTierEffect,
  buildRoomWorkforceInventory,
  getDesiredWorkerCount,
  getWorkerCap,
} from "@/runtime/roomWorkforce";
import { clearWorkerTaskBoardForTest, getWorkerTasksByRoom } from "@/runtime/workerTaskPool";
import type { WorkerTask } from "@/types/system";

function createSource(id: string, roomName: string, hasLink = false): Source {
  return {
    id,
    room: { name: roomName } as Room,
    pos: {
      findInRange: () => (hasLink ? ([{ structureType: STRUCTURE_LINK }] as StructureLink[]) : []),
    } as unknown as RoomPosition,
  } as Source;
}

function createMineral(
  id: string,
  options: {
    hasExtractor?: boolean;
    hasContainer?: boolean;
    amount?: number;
    mineralType?: MineralConstant;
  } = {},
): Mineral {
  const structures: Structure[] = [];
  if (options.hasExtractor) {
    structures.push({ structureType: STRUCTURE_EXTRACTOR } as StructureExtractor);
  }
  if (options.hasContainer) {
    structures.push({ structureType: STRUCTURE_CONTAINER } as StructureContainer);
  }

  return {
    id,
    mineralAmount: options.amount ?? 1000,
    mineralType: options.mineralType ?? RESOURCE_UTRIUM,
    pos: {
      findInRange: () => structures,
    } as unknown as RoomPosition,
  } as Mineral;
}

function createRoom(options: {
  name?: string;
  level?: number;
  constructionCount?: number;
  tasks?: Record<string, WorkerTask>;
  sources?: Source[];
  workerConstructionTier?: RoomMemory["workerConstructionTier"];
  minerals?: Mineral[];
} = {}): Room {
  const name = options.name ?? "W1N1";
  const memory = {
    workerConstructionTier: options.workerConstructionTier,
  } as RoomMemory;
  Memory.rooms[name] = memory;
  const sources = options.sources ?? [];
  const minerals = options.minerals ?? [];
  const constructionSites = Array.from({ length: options.constructionCount ?? 0 }, (_, index) => ({
    id: `site-${index}`,
  })) as ConstructionSite[];

  return {
    name,
    memory,
    controller: {
      level: options.level ?? 5,
    } as StructureController,
    find(type: FindConstant) {
      if (type === FIND_SOURCES) {
        return sources;
      }

      if (type === FIND_CONSTRUCTION_SITES) {
        return constructionSites;
      }

      if (type === FIND_MINERALS) {
        return minerals;
      }

      return [];
    },
  } as Room;
}

function getInventoryConfigNames(room: Room): string[] {
  return buildRoomWorkforceInventory(room).configs.map((config) => config.configName);
}

describe("roomWorkforce", () => {
  beforeEach(() => {
    clearWorkerTaskBoardForTest();
  });

  it("clamps worker cap to the supported range", () => {
    expect(getWorkerCap()).toBe(8);

    Memory.cfg = { worker: { maxPerRoom: 0 } };
    expect(getWorkerCap()).toBe(1);

    Memory.cfg = { worker: { maxPerRoom: 12 } };
    expect(getWorkerCap()).toBe(10);

    Memory.cfg = { worker: { maxPerRoom: 6 } };
    expect(getWorkerCap()).toBe(6);
    for (const [level, expected] of [
      [1, 5],
      [2, 4],
      [3, 3],
      [4, 1],
      [5, 1],
      [7, 1],
    ] as const) {
      expect(getDesiredWorkerCount(createRoom({ name: `W${level}N1`, level })))
        .toBe(expected);
    }
  });

  it("applies construction hysteresis, repair demand, and the RCL8 hard cap", () => {
    for (const [workerConstructionTier, constructionCount, expectedTier, expectedWorkers] of [
      [0, 1, 1, 2],
      [1, 0, 0, 1],
      [1, 6, 2, 3],
      [2, 4, 1, 2],
      [2, 15, 3, 4],
      [3, 12, 2, 3],
    ] as const) {
      const fixture = createRoom({
        name: `W${workerConstructionTier}N${constructionCount}`,
        level: 5,
        constructionCount,
        workerConstructionTier,
      });
      expect(getDesiredWorkerCount(fixture)).toBe(expectedWorkers);
      expect(fixture.memory.workerConstructionTier).toBe(expectedTier);
    }

    const room = createRoom({ level: 5, constructionCount: 6 });

    expect(getDesiredWorkerCount(room)).toBe(3);
    expect(room.memory.workerConstructionTier).toBe(2);

    room.find = ((type: FindConstant) => {
      if (type === FIND_SOURCES) {
        return [];
      }

      if (type === FIND_CONSTRUCTION_SITES) {
        return Array.from({ length: 5 }, (_, index) => ({ id: `site-mid-${index}` })) as ConstructionSite[];
      }

      return [];
    }) as Room["find"];

    expect(getDesiredWorkerCount(room)).toBe(3);
    expect(room.memory.workerConstructionTier).toBe(2);

    room.find = ((type: FindConstant) => {
      if (type === FIND_SOURCES) {
        return [];
      }

      if (type === FIND_CONSTRUCTION_SITES) {
        return Array.from({ length: 4 }, (_, index) => ({ id: `site-low-${index}` })) as ConstructionSite[];
      }

      return [];
    }) as Room["find"];

    expect(getDesiredWorkerCount(room)).toBe(2);
    expect(room.memory.workerConstructionTier).toBe(1);

    const normalRepairRoom = createRoom({ level: 5 });
    const normalTasks = getWorkerTasksByRoom(normalRepairRoom.name);
    normalTasks["repair:r1"] = {
      id: "repair:r1",
      type: "repair",
      targetId: "r1",
      roomName: normalRepairRoom.name,
      priority: 320,
      assignedCreeps: [],
      maxAssignees: 1,
      status: "active",
      updatedAt: Game.time,
      repairMode: "normal",
    };
    expect(getDesiredWorkerCount(normalRepairRoom)).toBe(2);

    const emergencyRepairRoom = createRoom({ name: "W1N2", level: 5 });
    const emergencyTasks = getWorkerTasksByRoom(emergencyRepairRoom.name);
    emergencyTasks["repair:r2"] = {
      id: "repair:r2",
      type: "repair",
      targetId: "r2",
      roomName: emergencyRepairRoom.name,
      priority: 900,
      assignedCreeps: [],
      maxAssignees: 1,
      status: "active",
      updatedAt: Game.time,
      repairMode: "emergency",
    };
    expect(getDesiredWorkerCount(emergencyRepairRoom)).toBe(1);

    const rcl8Room = createRoom({
      name: "W8N8",
      level: 8,
      constructionCount: 20,
      workerConstructionTier: 3,
    });
    const tasks = getWorkerTasksByRoom(rcl8Room.name);
    tasks["repair:r8"] = {
      id: "repair:r8",
      type: "repair",
      targetId: "r8",
      roomName: rcl8Room.name,
      priority: 320,
      assignedCreeps: [],
      maxAssignees: 1,
      status: "active",
      updatedAt: Game.time,
      repairMode: "normal",
    };

    expect(getDesiredWorkerCount(rcl8Room)).toBe(1);
    expect(rcl8Room.memory.workerConstructionTier).toBe(0);
  });

  it("builds typed source, mineral, carrier, and worker inventory with capacity cutovers", () => {
    const room = createRoom({
      level: 5,
      constructionCount: 6,
      workerConstructionTier: 1,
      sources: [createSource("source-a", "W1N1"), createSource("source-b", "W1N1", true)],
      minerals: [createMineral("mineral-a", { hasExtractor: true, hasContainer: true, amount: 4000 })],
    });

    const inventory = buildRoomWorkforceInventory(room);

    expect(room.memory.workerConstructionTier).toBe(1);
    expect(inventory.constructionTierEffect).toEqual({ kind: "set", value: 2 });
    expect(
      inventory.configs.map(({ kind, configName, role, args }) => ({ kind, configName, role, args })),
    ).toEqual([
      { kind: "source", configName: "W1N1:harvester:source-a", role: "harvester", args: ["source-a"] },
      { kind: "source", configName: "W1N1:miner:source-b", role: "miner", args: ["source-b"] },
      {
        kind: "mineral",
        configName: "W1N1:mineralHarvester:mineral-a",
        role: "mineralHarvester",
        args: ["mineral-a"],
      },
      { kind: "carrier", configName: "W1N1:carrier:0", role: "carrier", args: [] },
      { kind: "worker", configName: "W1N1:worker:0", role: "worker", args: [] },
      { kind: "worker", configName: "W1N1:worker:1", role: "worker", args: [] },
      { kind: "worker", configName: "W1N1:worker:2", role: "worker", args: [] },
    ]);
    expect(inventory.configs[0]).toMatchObject({
      kind: "source",
      deprecatedConfigName: "W1N1:miner:source-a",
    });

    applyRoomWorkforceConstructionTierEffect(room, inventory.constructionTierEffect);
    expect(room.memory.workerConstructionTier).toBe(2);

    const rcl3Room = createRoom({ name: "W1N3", level: 3, sources: [createSource("source-a", "W1N3")] });
    const rcl4Room = createRoom({ name: "W1N4", level: 4, sources: [createSource("source-a", "W1N4")] });
    const rcl5Room = createRoom({ name: "W1N5", level: 5, sources: [createSource("source-a", "W1N5")] });

    expect(getInventoryConfigNames(rcl3Room)).toEqual([
      "W1N3:harvester:source-a",
      "W1N3:carrier:0",
      "W1N3:carrier:1",
      "W1N3:worker:0",
      "W1N3:worker:1",
      "W1N3:worker:2",
    ]);

    expect(getInventoryConfigNames(rcl4Room)).toEqual([
      "W1N4:harvester:source-a",
      "W1N4:carrier:0",
      "W1N4:carrier:1",
      "W1N4:worker:0",
    ]);

    expect(getInventoryConfigNames(rcl5Room)).toEqual([
      "W1N5:harvester:source-a",
      "W1N5:carrier:0",
      "W1N5:worker:0",
    ]);
  });

  it("stops scheduling a replacement harvester while native X stock is over the buffer", () => {
    const room = createRoom({
      minerals: [createMineral("mineral-x", {
        mineralType: RESOURCE_CATALYST,
        hasExtractor: true,
        hasContainer: true,
      })],
    });
    room.storage = {
      store: { getUsedCapacity: () => 300_000 },
    } as unknown as StructureStorage;

    expect(getInventoryConfigNames(room)).not.toContain("W1N1:mineralHarvester:mineral-x");
  });

  it("keeps inventory observation pure until effects apply and preserves Reserve state", () => {
    const rcl8Room = createRoom({
      name: "W8N7",
      level: 8,
      constructionCount: 20,
      workerConstructionTier: 3,
    });
    const rcl8Inventory = buildRoomWorkforceInventory(rcl8Room);
    expect(rcl8Inventory.constructionTierEffect).toEqual({ kind: "set", value: 0 });
    expect(rcl8Inventory.configs.filter((config) => config.kind === "worker"))
      .toHaveLength(1);
    expect(rcl8Room.memory.workerConstructionTier).toBe(3);
    applyRoomWorkforceConstructionTierEffect(rcl8Room, rcl8Inventory.constructionTierEffect);
    expect(rcl8Room.memory.workerConstructionTier).toBe(0);

    const reserveRoom = createRoom({
      name: "W1N6",
      level: 5,
      constructionCount: 20,
      workerConstructionTier: 3,
      sources: [createSource("source-a", "W1N6")],
    });
    Game.flags.RESERVE_W1N6 = {
      name: "RESERVE_W1N6",
      pos: { roomName: reserveRoom.name } as RoomPosition,
    } as Flag;
    const reserveInventory = buildRoomWorkforceInventory(reserveRoom);
    expect(reserveInventory.constructionTierEffect).toEqual({ kind: "preserve" });
    expect(getInventoryConfigNames(reserveRoom)).toEqual([
      "W1N6:harvester:source-a",
      "W1N6:carrier:0",
    ]);
    expect(reserveRoom.memory.workerConstructionTier).toBe(3);

    const observedRoom = createRoom({ name: "W2N2", level: 5 });
    const beforeRepair = buildRoomWorkforceInventory(observedRoom);
    getWorkerTasksByRoom(observedRoom.name)["repair:r1"] = {
      id: "repair:r1",
      type: "repair",
      targetId: "r1",
      roomName: observedRoom.name,
      priority: 320,
      assignedCreeps: [],
      maxAssignees: 1,
      status: "active",
      updatedAt: Game.time,
      repairMode: "normal",
    };
    const afterRepair = buildRoomWorkforceInventory(observedRoom);
    expect(afterRepair).not.toBe(beforeRepair);
    expect(beforeRepair.configs.filter((config) => config.kind === "worker"))
      .toHaveLength(1);
    expect(afterRepair.configs.filter((config) => config.kind === "worker"))
      .toHaveLength(2);
  });
});
