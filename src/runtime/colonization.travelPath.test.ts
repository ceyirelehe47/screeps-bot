/**
 * 殖民持久缓存路径（cachedTravelPath）的版本化与生成语义测试。
 *
 * 覆盖：
 * - 旧版无版本 key 的缓存被拒绝并在正常生命周期中重新生成覆盖；
 * - 新版 key 在参数未变时跨 tick 复用；
 * - routeRooms / dangerousRooms 变化触发重建；
 * - 搜索失败时删除旧缓存而不是留下永久拒绝状态；
 * - 生成回调复用共用静态障碍矩阵（含不可见房间的 terrain-only 退化）。
 */
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

jest.mock("@/runtime/roomPlannerConstruction", () => ({
  getSourceContainerPositionsForRoom: jest.fn(() => []),
}));

import { runColonizationByFlag } from "@/runtime/colonization";
import { isDefenseMode } from "@/runtime/defenseMode";
import {
  COLONIZATION_TRAVEL_PATH_VERSION,
  clearRoutingCachesForTest,
  getColonizationTravelPathKey,
} from "@/movement/routing";
import type { CachedTravelPath } from "@/movement/types";
import { RealCostMatrix, resetRuntimeServices } from "@mock/movement";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
  PathFinder?: { search: jest.Mock; CostMatrix: new () => CostMatrix };
};

class MockRoomPosition {
  constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}
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
      pos: new MockRoomPosition(25, 25, name),
    } as unknown as StructureController,
    find: jest.fn(() => []),
  } as unknown as Room;
}

function createSpawn(room: Room): StructureSpawn {
  return {
    room,
    pos: {} as RoomPosition,
    owner: { username: "me" } as Owner,
    memory: { spawnList: [] },
    isActive: jest.fn(() => true),
    addTask: jest.fn(),
  } as unknown as StructureSpawn;
}

interface TaskSeed {
  cachedTravelPath?: CachedTravelPath;
  scoutRouteRooms?: string[];
  dangerousRooms?: string[];
  permanentDangerousRooms?: string[];
}

function seedTask(seed: TaskSeed = {}): void {
  Memory.data = {
    colonization: {
      W1N2: {
        targetRoom: "W1N2",
        sourceRoom: "W1N1",
        status: "claiming",
        flagName: "CL",
        planReady: false,
        claimCompleted: false,
        scoutSafe: true,
        scoutRouteRooms: seed.scoutRouteRooms ?? ["W1N1", "W1N2"],
        dangerousRooms: seed.dangerousRooms ?? [],
        permanentDangerousRooms: seed.permanentDangerousRooms ?? [],
        temporaryDangerousRooms: {},
        cachedTravelPath: seed.cachedTravelPath,
        createdAt: Game.time,
        updatedAt: Game.time,
      },
    },
  } as Memory["data"];
}

function legacyCachedTravelPath(): CachedTravelPath {
  // 部署前旧代码生成的无版本 key。
  return {
    key: "W1N1->W1N2|r:W1N1>W1N2|d:",
    sourceRoom: "W1N1",
    targetRoom: "W1N2",
    routeRooms: ["W1N1", "W1N2"],
    positions: [{ x: 26, y: 25, roomName: "W1N1" }],
    generatedAt: Game.time - 100,
  };
}

describe("colonization cachedTravelPath lifecycle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetRuntimeServices();
    clearRoutingCachesForTest();
    Game.time += 1;
    Memory.data = undefined;
    Game.rooms = {};
    Game.spawns = {};
    Game.creeps = {};
    Game.flags = {};
    (isDefenseMode as jest.Mock).mockReturnValue(false);

    Object.assign(Game, {
      map: {
        getRoomLinearDistance: jest.fn(() => 1),
        getRoomStatus: jest.fn(() => ({ status: "normal" })),
        findRoute: jest.fn(() => ERR_NO_PATH),
        describeExits: jest.fn((roomName: string) => {
          if (roomName === "W1N1") {
            return { [RIGHT]: "W1N2", [BOTTOM]: "W2N1" };
          }
          if (roomName === "W1N2") {
            return { [LEFT]: "W1N1" };
          }
          if (roomName === "W2N1") {
            return { [TOP]: "W1N1", [RIGHT]: "W1N2" };
          }
          return null;
        }),
        getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) })),
      },
    });

    Object.assign(global, {
      RoomPosition: MockRoomPosition,
      PathFinder: {
        search: jest.fn(() => ({
          incomplete: false,
          path: [
            { x: 26, y: 25, roomName: "W1N1" },
            { x: 27, y: 25, roomName: "W1N1" },
          ],
        })),
        CostMatrix: RealCostMatrix as unknown as new () => CostMatrix,
      },
    });
  });

  function setupWorld(): void {
    const sourceRoom = createSourceRoom("W1N1");
    const spawn = createSpawn(sourceRoom);
    Game.rooms[sourceRoom.name] = sourceRoom;
    Game.spawns.Spawn1 = spawn;
    Game.flags.CL = {
      name: "CL",
      pos: { roomName: "W1N2" } as RoomPosition,
      remove: jest.fn(),
    } as unknown as Flag;
  }

  it("rejects legacy version-less cached path keys and regenerates with the new version", () => {
    setupWorld();
    seedTask({ cachedTravelPath: legacyCachedTravelPath() });

    runColonizationByFlag();

    const task = Memory.data?.colonization?.W1N2;
    expect(task?.cachedTravelPath).toBeDefined();
    expect(task?.cachedTravelPath?.key).toBe(getColonizationTravelPathKey("W1N1", "W1N2", ["W1N1", "W1N2"], []));
    expect(task?.cachedTravelPath?.key.startsWith(`v${COLONIZATION_TRAVEL_PATH_VERSION}:`)).toBe(true);
    expect((global as RuntimeGlobal).PathFinder?.search).toHaveBeenCalled();
  });

  it("reuses the cached path across ticks while parameters are unchanged", () => {
    setupWorld();
    seedTask();

    runColonizationByFlag();
    const firstPath = Memory.data?.colonization?.W1N2?.cachedTravelPath;
    expect(firstPath).toBeDefined();
    expect((global as RuntimeGlobal).PathFinder?.search).toHaveBeenCalledTimes(1);

    Game.time += 1;
    runColonizationByFlag();

    expect(Memory.data?.colonization?.W1N2?.cachedTravelPath).toBe(firstPath);
    expect((global as RuntimeGlobal).PathFinder?.search).toHaveBeenCalledTimes(1);
  });

  it("regenerates the cached path when the scout route changes", () => {
    setupWorld();
    seedTask();

    runColonizationByFlag();
    expect((global as RuntimeGlobal).PathFinder?.search).toHaveBeenCalledTimes(1);

    const task = Memory.data!.colonization!.W1N2!;
    task.scoutRouteRooms = ["W1N1", "W2N1", "W1N2"];
    runColonizationByFlag();

    expect((global as RuntimeGlobal).PathFinder?.search).toHaveBeenCalledTimes(2);
    // upsertColonizationTask 每轮重建任务对象，须重新读取。
    expect(Memory.data?.colonization?.W1N2?.cachedTravelPath?.key).toBe(
      getColonizationTravelPathKey("W1N1", "W1N2", ["W1N1", "W2N1", "W1N2"], []),
    );
  });

  it("regenerates the cached path when dangerous rooms change", () => {
    setupWorld();
    seedTask();

    runColonizationByFlag();
    expect((global as RuntimeGlobal).PathFinder?.search).toHaveBeenCalledTimes(1);

    const task = Memory.data!.colonization!.W1N2!;
    task.permanentDangerousRooms = ["W9N9"];
    runColonizationByFlag();

    expect((global as RuntimeGlobal).PathFinder?.search).toHaveBeenCalledTimes(2);
    expect(Memory.data?.colonization?.W1N2?.cachedTravelPath?.key).toBe(
      getColonizationTravelPathKey("W1N1", "W1N2", ["W1N1", "W1N2"], ["W9N9"]),
    );
  });

  it("deletes the stale path on search failure and recovers on the next attempt", () => {
    setupWorld();
    seedTask({ cachedTravelPath: legacyCachedTravelPath() });
    (global as RuntimeGlobal).PathFinder!.search.mockReturnValueOnce({ incomplete: true, path: [] });

    runColonizationByFlag();
    expect(Memory.data?.colonization?.W1N2?.cachedTravelPath).toBeUndefined();

    Game.time += 1;
    runColonizationByFlag();
    expect(Memory.data?.colonization?.W1N2?.cachedTravelPath).toBeDefined();
  });

  it("builds the persistent path with engine static obstacle semantics", () => {
    setupWorld();
    seedTask();

    const sourceRoom = Game.rooms.W1N1 as Room & { find: jest.Mock };
    const controllerPos = new MockRoomPosition(25, 25, "W1N1");
    (sourceRoom as unknown as { controller: StructureController }).controller = {
      my: true,
      level: 5,
      pos: controllerPos,
    } as unknown as StructureController;
    sourceRoom.find.mockImplementation((findConstant: number) => {
      switch (findConstant) {
        case FIND_STRUCTURES:
          return [
            { structureType: STRUCTURE_ROAD, pos: new MockRoomPosition(5, 5, "W1N1") },
            { structureType: STRUCTURE_PORTAL, pos: new MockRoomPosition(40, 40, "W1N1") },
            { structureType: STRUCTURE_EXTENSION, pos: new MockRoomPosition(35, 35, "W1N1") },
            { structureType: STRUCTURE_RAMPART, pos: new MockRoomPosition(30, 30, "W1N1"), my: false, isPublic: true },
            { structureType: STRUCTURE_RAMPART, pos: new MockRoomPosition(31, 31, "W1N1"), my: false, isPublic: false },
          ];
        case FIND_CONSTRUCTION_SITES:
          return [
            { structureType: STRUCTURE_WALL, pos: new MockRoomPosition(10, 10, "W1N1"), my: true },
            { structureType: STRUCTURE_WALL, pos: new MockRoomPosition(12, 12, "W1N1"), my: false },
          ];
        case FIND_SOURCES:
          return [{ pos: new MockRoomPosition(20, 20, "W1N1") }];
        case FIND_MINERALS:
          return [{ pos: new MockRoomPosition(21, 21, "W1N1") }];
        case FIND_DEPOSITS:
          return [{ pos: new MockRoomPosition(22, 22, "W1N1") }];
        case FIND_MY_CREEPS:
          return [{ name: "dynamic-creep", pos: new MockRoomPosition(8, 8, "W1N1") }];
        default:
          return [];
      }
    });
    (Game.map.getRoomTerrain as jest.Mock).mockImplementation((roomName: string) => ({
      get: (x: number, y: number) => (roomName === "W1N1" && x === 15 && y === 15 ? TERRAIN_MASK_WALL : 0),
    }));

    let capturedMatrix: RealCostMatrix | undefined;
    (global as RuntimeGlobal).PathFinder!.search.mockImplementation(
      (_origin: unknown, _goal: unknown, opts: { roomCallback: (roomName: string) => boolean | CostMatrix }) => {
        capturedMatrix = opts.roomCallback("W1N1") as unknown as RealCostMatrix;
        return { incomplete: false, path: [{ x: 26, y: 25, roomName: "W1N1" }] };
      },
    );

    runColonizationByFlag();

    expect(capturedMatrix).toBeDefined();
    // Source / Mineral / Deposit / Controller / Portal / terrain wall / 不可通行
    // 结构与自家工地全部 0xff；敌方工地不拦。
    expect(capturedMatrix?.get(20, 20)).toBe(0xff);
    expect(capturedMatrix?.get(21, 21)).toBe(0xff);
    expect(capturedMatrix?.get(22, 22)).toBe(0xff);
    expect(capturedMatrix?.get(25, 25)).toBe(0xff);
    expect(capturedMatrix?.get(40, 40)).toBe(0xff);
    expect(capturedMatrix?.get(15, 15)).toBe(0xff);
    expect(capturedMatrix?.get(35, 35)).toBe(0xff);
    expect(capturedMatrix?.get(31, 31)).toBe(0xff);
    expect(capturedMatrix?.get(10, 10)).toBe(0xff);
    // road 成本 1；公共 rampart 可通行；动态 creep 不进持久矩阵。
    expect(capturedMatrix?.get(5, 5)).toBe(1);
    expect(capturedMatrix?.get(30, 30)).toBe(0);
    expect(capturedMatrix?.get(12, 12)).toBe(0);
    expect(capturedMatrix?.get(8, 8)).toBe(0);
  });

  it("uses terrain-only matrices for invisible route rooms and keeps route restrictions", () => {
    setupWorld();
    seedTask({ scoutRouteRooms: ["W1N1", "W2N1", "W1N2"] });

    (Game.map.getRoomTerrain as jest.Mock).mockImplementation((roomName: string) => ({
      get: (x: number, y: number) => (roomName === "W2N1" && x === 7 && y === 7 ? TERRAIN_MASK_WALL : 0),
    }));

    const captured: Record<string, boolean | RealCostMatrix> = {};
    (global as RuntimeGlobal).PathFinder!.search.mockImplementation(
      (_origin: unknown, _goal: unknown, opts: { roomCallback: (roomName: string) => boolean | CostMatrix }) => {
        captured.W1N1 = opts.roomCallback("W1N1") as unknown as RealCostMatrix;
        captured.W2N1 = opts.roomCallback("W2N1") as unknown as RealCostMatrix;
        captured.offRoute = opts.roomCallback("W9N9") as boolean;
        return { incomplete: false, path: [{ x: 26, y: 25, roomName: "W1N1" }] };
      },
    );

    runColonizationByFlag();

    // 不可见中转房：只有 terrain（wall 0xff），不掌握结构信息。
    const invisibleMatrix = captured.W2N1 as RealCostMatrix;
    expect(invisibleMatrix.get(7, 7)).toBe(0xff);
    expect(invisibleMatrix.get(8, 8)).toBe(0);
    expect(invisibleMatrix.get(5, 5)).toBe(0);
    // 不在允许路线上的房间直接拒绝。
    expect(captured.offRoute).toBe(false);
  });
});
