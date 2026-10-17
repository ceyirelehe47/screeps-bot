jest.mock("@/runtime/defenseMode", () => ({
  isDefenseMode: jest.fn(() => false),
}));

jest.mock("@/runtime/safeZone", () => ({
  getSafeZone: jest.fn(() => new Set<number>()),
}));

import {
  clearCreepAssignmentStateForTest,
  ensureCreepAssignmentState,
  getCreepAssignmentState,
  pruneDeadCreepAssignmentState,
} from "@/runtime/creepAssignmentState";
import { isDefenseMode } from "@/runtime/defenseMode";
import { getCreepConfigService } from "@/runtime/runtimeServices";
import { getSafeZone } from "@/runtime/safeZone";
import {
  assignWorkerTask,
  deferUnreachableWorkerTask,
  cleanupWorkerTaskBoard,
  clearWorkerTaskBoardForTest,
  getAssignedWorkerTaskId,
  getWorkerTasksByRoom,
  isWorkerTaskSafeForCreep,
  peekWorkerTaskBoard,
  refreshWorkerTasks,
  releaseWorkerTask,
} from "@/runtime/workerTaskPool";
import type { RoleName, WorkerTask } from "@/types/system";

type RuntimeGlobal = typeof global & {
  RoomPosition?: typeof MockRoomPosition;
  __runtimeServices?: unknown;
  __workerTaskBoard?: Record<string, Record<string, WorkerTask>>;
};

class MockRoomPosition {
  public constructor(
    public readonly x: number,
    public readonly y: number,
    public readonly roomName: string,
  ) {}

  public getRangeTo(target: { x: number; y: number }): number {
    return Math.max(Math.abs(target.x - this.x), Math.abs(target.y - this.y));
  }

  public findInRange(): never[] {
    return [];
  }
}

function createPos(roomName: string, x: number, y: number): RoomPosition {
  return new MockRoomPosition(x, y, roomName) as unknown as RoomPosition;
}

function createCreep(
  name: string,
  roomName: string,
  x = 25,
  y = 25,
  configName?: string,
): Creep {
  const room = (Game.rooms[roomName] || { name: roomName }) as Room;
  return {
    name,
    room,
    pos: createPos(roomName, x, y),
    memory: {
      configName,
      role: "worker",
    } as CreepMemory,
  } as Creep;
}

function createTask(
  id: string,
  roomName: string,
  targetId: string,
  overrides: Partial<WorkerTask> = {},
): WorkerTask {
  return {
    id,
    type: "build",
    targetId,
    roomName,
    priority: 300,
    assignedCreeps: [],
    maxAssignees: 1,
    status: "active",
    updatedAt: Game.time,
    ...overrides,
  };
}

function createTarget(id: string, roomName: string, x: number, y: number): RoomObject {
  return {
    id,
    pos: createPos(roomName, x, y),
    room: (Game.rooms[roomName] || { name: roomName }) as Room,
  } as unknown as RoomObject;
}

function publishTask(task: WorkerTask): WorkerTask {
  getWorkerTasksByRoom(task.roomName)[task.id] = task;
  return task;
}

function createOwnedRoom(
  name: string,
  options: {
    level?: number;
    structures?: Structure<StructureConstant>[];
    myStructures?: Structure<StructureConstant>[];
    constructionSites?: ConstructionSite[];
    storage?: StructureStorage;
  } = {},
): Room {
  const roomMemory = {} as RoomMemory;
  Memory.rooms[name] = roomMemory;
  const structures = options.structures || [];
  const myStructures = options.myStructures || [];
  const constructionSites = options.constructionSites || [];
  const controller = {
    id: `controller:${name}` as Id<StructureController>,
    my: true,
    level: options.level ?? 5,
    ticksToDowngrade: 20_000,
    pos: createPos(name, 25, 25),
  } as StructureController;

  const room = {
    name,
    memory: roomMemory,
    controller,
    storage: options.storage,
    find: jest.fn((type: FindConstant) => {
      if (type === FIND_STRUCTURES) return structures;
      if (type === FIND_MY_STRUCTURES) return myStructures;
      if (type === FIND_CONSTRUCTION_SITES) return constructionSites;
      if (type === FIND_MY_CREEPS) {
        return Object.values(Game.creeps).filter((creep) => creep.room.name === name);
      }
      return [];
    }),
  } as unknown as Room;

  (controller as StructureController & { room: Room }).room = room;
  Game.rooms[name] = room;
  return room;
}

function createConstructionSite(
  id: string,
  room: Room,
  x: number,
  y: number,
  overrides: Partial<ConstructionSite> = {},
): ConstructionSite {
  return {
    id: id as Id<ConstructionSite>,
    room,
    pos: createPos(room.name, x, y),
    structureType: STRUCTURE_EXTENSION,
    progress: 0,
    progressTotal: 3_000,
    ...overrides,
  } as ConstructionSite;
}

describe("workerTaskPool legacy dispatch characterization", () => {
  let objects: Record<string, RoomObject>;

  function resetDispatchScenario(): void {
    delete (global as RuntimeGlobal).__runtimeServices;
    clearCreepAssignmentStateForTest();
    clearWorkerTaskBoardForTest();
    Game.rooms = {};
    Game.creeps = {};
    Memory.rooms = {};
    Memory.data = {} as Memory["data"];
    (global as RuntimeGlobal).RoomPosition = MockRoomPosition;
    (isDefenseMode as jest.Mock).mockReturnValue(false);
    (getSafeZone as jest.Mock).mockReturnValue(new Set<number>());
    objects = {};
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn(
      (id: string) => objects[id] || null,
    ) as unknown as Game["getObjectById"];
  }

  beforeEach(resetDispatchScenario);

  function configure(configName: string, role: RoleName, roomName: string): void {
    getCreepConfigService().upsert(configName, role, [], roomName);
  }

  function addCandidate(
    roomName: string,
    id: string,
    targetId: string,
    x: number,
    y: number,
    overrides: Partial<WorkerTask> = {},
  ): WorkerTask {
    objects[targetId] = createTarget(targetId, roomName, x, y);
    return publishTask(createTask(id, roomName, targetId, overrides));
  }

  it("无路工地仅对失败工人暂停 50 tick，其它工人可接手且到期重试", () => {
    Game.time = 100;
    const worker = createCreep("blocked-worker", "W1N1");
    const other = createCreep("other-worker", "W1N1");
    Game.creeps = { [worker.name]: worker, [other.name]: other };
    const task = addCandidate("W1N1", "build:blocked", "blocked", 20, 20);
    expect(assignWorkerTask(worker)).toBe(task);
    deferUnreachableWorkerTask(worker, task);
    expect(task.assignedCreeps).not.toContain(worker.name);
    for (const tick of [101, 120, 149]) {
      Game.time = tick;
      expect(assignWorkerTask(worker)).toBeNull();
    }
    expect(assignWorkerTask(other)).toBe(task);
    releaseWorkerTask(other);
    Game.time = 150;
    expect(assignWorkerTask(worker)).toBe(task);
  });

  it("routes ordinary workers to config home, colonizers to their physical room, and missing configs to the physical room", () => {
    configure("ordinary-config", "worker", "W1N1");
    configure("colonizer-config", "colonizerWorker", "W1N1");
    configure("cross-shard-config", "crossShardColonizerWorker", "W1N1");

    const homeTask = addCandidate("W1N1", "build:home", "home-target", 20, 20);
    const colonizerTask = addCandidate("W2N2", "build:colonizer", "colonizer-target", 20, 20);
    const crossShardTask = addCandidate("W3N3", "build:cross-shard", "cross-shard-target", 20, 20);
    const fallbackTask = addCandidate("W4N4", "build:fallback", "fallback-target", 20, 20);

    const ordinary = createCreep("Ordinary", "W9N9", 25, 25, "ordinary-config");
    const colonizer = createCreep("Colonizer", "W2N2", 25, 25, "colonizer-config");
    const crossShard = createCreep("CrossShard", "W3N3", 25, 25, "cross-shard-config");
    const fallback = createCreep("Fallback", "W4N4", 25, 25, "missing-config");
    Game.creeps = {
      [ordinary.name]: ordinary,
      [colonizer.name]: colonizer,
      [crossShard.name]: crossShard,
      [fallback.name]: fallback,
    };

    expect(assignWorkerTask(ordinary)).toBe(homeTask);
    expect(assignWorkerTask(colonizer)).toBe(colonizerTask);
    expect(assignWorkerTask(crossShard)).toBe(crossShardTask);
    expect(assignWorkerTask(fallback)).toBe(fallbackTask);
    expect(getAssignedWorkerTaskId(ordinary.name)).toBe(homeTask.id);
    expect(getAssignedWorkerTaskId(colonizer.name)).toBe(colonizerTask.id);
    expect(getAssignedWorkerTaskId(crossShard.name)).toBe(crossShardTask.id);
    expect(getAssignedWorkerTaskId(fallback.name)).toBe(fallbackTask.id);

    resetDispatchScenario();
    const sticky = createCreep("Sticky", "W5N5", 25, 25);
    const existing = createCreep("Existing", "W5N5", 25, 25);
    const newcomer = createCreep("Newcomer", "W5N5", 25, 25);
    Game.creeps = {
      [sticky.name]: sticky,
      [existing.name]: existing,
      [newcomer.name]: newcomer,
    };
    ensureCreepAssignmentState(sticky.name).taskId = "build:sticky";
    ensureCreepAssignmentState(existing.name).taskId = "build:sticky";
    const stickyTask = addCandidate(
      "W5N5",
      "build:sticky",
      "sticky-target",
      30,
      30,
      { priority: 1, maxAssignees: 1, assignedCreeps: [existing.name] },
    );
    addCandidate("W5N5", "build:better", "better-target", 25, 26, { priority: 900 });

    expect(assignWorkerTask(sticky)).toBe(stickyTask);
    expect(stickyTask.assignedCreeps).toEqual([existing.name, sticky.name]);
    releaseWorkerTask(existing);
    releaseWorkerTask(sticky);
    delete getWorkerTasksByRoom("W5N5")["build:better"];
    ensureCreepAssignmentState(existing.name).taskId = stickyTask.id;
    stickyTask.assignedCreeps = [existing.name];
    expect(assignWorkerTask(newcomer)).toBeNull();
    expect(getAssignedWorkerTaskId(newcomer.name)).toBeUndefined();

    resetDispatchScenario();
    const defended = createCreep("Defended", "W6N6", 25, 25);
    Game.creeps[defended.name] = defended;
    const outside = addCandidate(
      "W6N6",
      "build:outside",
      "outside-target",
      10,
      10,
      { priority: 900, assignedCreeps: [defended.name] },
    );
    const inside = addCandidate(
      "W6N6",
      "build:inside",
      "inside-target",
      20,
      20,
      { priority: 100 },
    );
    ensureCreepAssignmentState(defended.name).taskId = outside.id;
    (isDefenseMode as jest.Mock).mockReturnValue(true);
    (getSafeZone as jest.Mock).mockReturnValue(new Set([20 * 50 + 20]));

    expect(isWorkerTaskSafeForCreep(defended, outside)).toBe(false);
    expect(isWorkerTaskSafeForCreep(defended, inside)).toBe(true);
    expect(assignWorkerTask(defended)).toBe(inside);
    expect(outside.assignedCreeps).toEqual([]);
    expect(inside.assignedCreeps).toEqual([defended.name]);
    expect(getAssignedWorkerTaskId(defended.name)).toBe(inside.id);
  });
});

describe("workerTaskPool legacy refresh and cleanup characterization", () => {
  let objects: Record<string, RoomObject>;

  function resetRefreshScenario(): void {
    delete (global as RuntimeGlobal).__runtimeServices;
    clearCreepAssignmentStateForTest();
    clearWorkerTaskBoardForTest();
    Game.rooms = {};
    Game.creeps = {};
    Memory.rooms = {};
    Memory.data = {} as Memory["data"];
    (global as RuntimeGlobal).RoomPosition = MockRoomPosition;
    (isDefenseMode as jest.Mock).mockReturnValue(false);
    (getSafeZone as jest.Mock).mockReturnValue(new Set<number>());
    objects = {};
    (Game as Game & { getObjectById: Game["getObjectById"] }).getObjectById = jest.fn(
      (id: string) => objects[id] || null,
    ) as unknown as Game["getObjectById"];
  }

  beforeEach(resetRefreshScenario);

  function registerRoomTargets(room: Room): void {
    if (room.controller) {
      objects[room.controller.id] = room.controller;
    }
    for (const structure of room.find(FIND_STRUCTURES)) {
      objects[structure.id] = structure;
    }
    for (const site of room.find(FIND_CONSTRUCTION_SITES)) {
      objects[site.id] = site;
    }
  }

  it("honors refresh cadence and stable identity across reset while cleaning dead ownership", () => {
    resetRefreshScenario();
    Game.time = 3;
    const cadenceSites: ConstructionSite[] = [];
    const cadenceRoom = createOwnedRoom("W1N1", {
      level: 5,
      constructionSites: cadenceSites,
    });
    const cadenceSite = createConstructionSite("cadence-site", cadenceRoom, 20, 20);
    cadenceSites.push(cadenceSite);
    registerRoomTargets(cadenceRoom);
    refreshWorkerTasks();
    expect(getWorkerTasksByRoom(cadenceRoom.name)["build:cadence-site"]).toBeDefined();

    clearWorkerTaskBoardForTest();
    delete (global as RuntimeGlobal).__runtimeServices;
    Game.time = 4;
    refreshWorkerTasks();
    expect((global as RuntimeGlobal).__workerTaskBoard).toBeUndefined();
    expect(peekWorkerTaskBoard()).toEqual({});
    Game.time = 6;
    refreshWorkerTasks();
    expect(getWorkerTasksByRoom(cadenceRoom.name)["build:cadence-site"]).toMatchObject({
      id: "build:cadence-site",
      updatedAt: 6,
    });

    resetRefreshScenario();
    Game.time = 3;
    const stableSites: ConstructionSite[] = [];
    const stableRoom = createOwnedRoom("W2N2", {
      level: 5,
      constructionSites: stableSites,
    });
    const stableSite = createConstructionSite("stable-site", stableRoom, 20, 20, {
      progress: 500,
      progressTotal: 3_000,
    });
    stableSites.push(stableSite);
    registerRoomTargets(stableRoom);
    refreshWorkerTasks();
    const original = getWorkerTasksByRoom(stableRoom.name)["build:stable-site"];
    const creep = createCreep("Worker", stableRoom.name);
    Game.creeps[creep.name] = creep;
    ensureCreepAssignmentState(creep.name).taskId = original.id;
    original.assignedCreeps = [creep.name];
    (stableSite as ConstructionSite & { progress: number }).progress = 1_500;
    Game.time = 6;
    refreshWorkerTasks();
    const refreshed = getWorkerTasksByRoom(stableRoom.name)[original.id];
    expect(refreshed).toBe(original);
    expect(refreshed).toMatchObject({ requiredWork: 1_500, updatedAt: 6 });
    expect(refreshed.assignedCreeps).toEqual([creep.name]);
    expect(getAssignedWorkerTaskId(creep.name)).toBe(original.id);

    resetRefreshScenario();
    Game.time = 3;
    const cleanupSites: ConstructionSite[] = [];
    const cleanupRoom = createOwnedRoom("W3N3", { constructionSites: cleanupSites });
    const cleanupSite = createConstructionSite("cleanup-site", cleanupRoom, 20, 20);
    cleanupSites.push(cleanupSite);
    registerRoomTargets(cleanupRoom);
    refreshWorkerTasks();
    const cleanupTask = getWorkerTasksByRoom(cleanupRoom.name)["build:cleanup-site"];
    cleanupTask.assignedCreeps = ["DeadWorker"];
    ensureCreepAssignmentState("DeadWorker").taskId = cleanupTask.id;
    getWorkerTasksByRoom("W9N9")["build:abandoned"] = createTask(
      "build:abandoned",
      "W9N9",
      "missing-target",
    );
    Game.time = 6;
    refreshWorkerTasks();
    expect(cleanupTask.assignedCreeps).toEqual([]);
    expect(getCreepAssignmentState("DeadWorker")?.taskId).toBe(cleanupTask.id);
    expect(cleanupWorkerTaskBoard(new Set([cleanupRoom.name]))).toBe(1);
    expect(peekWorkerTaskBoard()).toEqual({
      [cleanupRoom.name]: expect.objectContaining({ [cleanupTask.id]: cleanupTask }),
    });
    expect(pruneDeadCreepAssignmentState()).toBe(1);
    expect(getCreepAssignmentState("DeadWorker")).toBeUndefined();
  });
});
