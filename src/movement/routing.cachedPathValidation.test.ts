/**
 * colonization 缓存路径跟随的运行时局部验证与游标重置测试。
 *
 * 覆盖：
 * - 缓存下一步被当前可见房间的静态障碍（自然对象/新建筑）挡住时：
 *   不执行该步、失效缓存路径、清游标、回退实时寻路；
 * - 当前房间不可见时不做验证，缓存路径照常跟随；
 * - 路径 key 变化后旧 cachedPathCursor 不会错误定位新路径。
 */
import { clearCreepMovementStateForTest, ensureCreepMovementState, getCreepMovementState } from "@/movement/creepState";
import { clearMovementAnalyticsForTest } from "@/movement/metrics";
import { clearRoomBaseCostMatrixCacheForTest } from "@/movement/pathing";
import {
  COLONIZATION_TRAVEL_PATH_RETRY_INTERVAL,
  clearRoutingCachesForTest,
  getColonizationTravelPathKey,
  moveToTargetRoom,
} from "@/movement/routing";
import type { CachedTravelPath, StoredRoomPosition } from "@/movement/types";
import {
  MockRoomPosition,
  RealCostMatrix,
  createCreep,
  createRoom,
  resetRuntimeServices,
  setDefaultMapMocks,
  setupPathFinderGlobal,
  setupRoomPositionGlobal,
} from "@mock/movement";

jest.mock("@/runtime/roomPlannerConstruction", () => ({
  getSourceContainerPositionsForRoom: jest.fn(() => []),
}));

type PathFinderGlobal = typeof global & {
  PathFinder?: { search: jest.Mock; CostMatrix: new () => CostMatrix };
};

function storedPositions(points: Array<[number, number, string]>): StoredRoomPosition[] {
  return points.map(([x, y, roomName]) => ({ x, y, roomName }));
}

function setupCachedPath(positions: StoredRoomPosition[]): CachedTravelPath {
  const path: CachedTravelPath = {
    key: getColonizationTravelPathKey("W1N1", "W1N2", ["W1N1", "W1N2"], []),
    sourceRoom: "W1N1",
    targetRoom: "W1N2",
    routeRooms: ["W1N1", "W1N2"],
    positions,
    generatedAt: Game.time,
  };
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
        scoutRouteRooms: ["W1N1", "W1N2"],
        dangerousRooms: [],
        cachedTravelPath: path,
        createdAt: Game.time,
        updatedAt: Game.time,
      },
    },
  } as Memory["data"];
  return path;
}

function makeVisibleRoom(): Room {
  const room = createRoom("W1N1") as Room & { findExitTo: jest.Mock };
  room.findExitTo = jest.fn(() => RIGHT);
  // mock 的 controller 无 pos；删除以避免 controller 区域回避读取 pos（与
  // routing.dynamicObstacles.test.ts 的处理一致）。
  delete (room as unknown as { controller?: unknown }).controller;
  return room;
}

function makeInvisibleRoom(): Room {
  return {
    name: "W1N1",
    findExitTo: jest.fn(() => RIGHT),
    find: jest.fn(() => []),
  } as unknown as Room;
}

describe("moveToTargetRoom cached travel path validation", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearCreepMovementStateForTest();
    clearMovementAnalyticsForTest();
    clearRoomBaseCostMatrixCacheForTest();
    clearRoutingCachesForTest();
    Game.time += 1;
    Memory.data = undefined;
    Game.rooms = {};
    Game.creeps = {};
    Game.powerCreeps = {};
    setupRoomPositionGlobal();
    setupPathFinderGlobal(RealCostMatrix as unknown as new () => CostMatrix);
    setDefaultMapMocks();
    Game.map.describeExits = jest.fn((roomName: string) => {
      if (roomName === "W1N1") {
        return { [RIGHT]: "W1N2" };
      }
      if (roomName === "W1N2") {
        return { [LEFT]: "W1N1" };
      }
      return null;
    });
  });

  it("skips and invalidates a cached step blocked by a natural obstacle, then falls back to live search", () => {
    const room = makeVisibleRoom();
    (room as unknown as { find: jest.Mock }).find = jest.fn((findConstant: number) => {
      if (findConstant === FIND_SOURCES) {
        // 缓存下一步 (10,11) 已被 Source 占据。
        return [{ pos: new MockRoomPosition(10, 11, "W1N1") }];
      }
      return [];
    });
    const creep = createCreep("claimer", "claimer", 10, 10, room);
    (creep.pos as unknown as { findClosestByPath: jest.Mock }).findClosestByPath = jest.fn(() => null);
    (creep.pos as unknown as { findClosestByRange: jest.Mock }).findClosestByRange = jest.fn(() => null);
    setupCachedPath(storedPositions([
      [10, 10, "W1N1"],
      [10, 11, "W1N1"],
      [10, 12, "W1N1"],
    ]));

    moveToTargetRoom(creep, "W1N2", "W1N1|W1N2");

    // 被阻挡的一步绝不提交。
    expect(creep.move).not.toHaveBeenCalledWith(BOTTOM);
    // 缓存路径整体失效（回退后由生命周期重新生成）。
    expect(Memory.data?.colonization?.W1N2?.cachedTravelPath).toBeUndefined();
    // 失效同时设置重试节流：防止"删除→立即重生成→再被验证删除"的
    // 逐 tick 重搜循环（colonization 系 CPU 放大器）。
    expect(Memory.data?.colonization?.W1N2?.travelPathRetryAt).toBe(
      Game.time + COLONIZATION_TRAVEL_PATH_RETRY_INTERVAL,
    );
    // 游标同步清理。
    expect(getCreepMovementState(creep.name)?.travelState?.cachedPathCursor).toBeUndefined();
    // 回退到实时跨房寻路。
    expect((global as PathFinderGlobal).PathFinder?.search).toHaveBeenCalled();
  });

  it("follows the cached path without validation while the current room is invisible", () => {
    const room = makeInvisibleRoom();
    const creep = createCreep("claimer", "claimer", 10, 10, room);
    const path = setupCachedPath(storedPositions([
      [10, 10, "W1N1"],
      [10, 11, "W1N1"],
      [10, 12, "W1N1"],
    ]));

    const result = moveToTargetRoom(creep, "W1N2", "W1N1|W1N2");

    expect(result).toBe(OK);
    expect(creep.move).toHaveBeenCalledWith(BOTTOM);
    expect(Memory.data?.colonization?.W1N2?.cachedTravelPath).toBe(path);
  });

  it("resets the cachedPathCursor when the path key changes", () => {
    const room = makeInvisibleRoom();
    const creep = createCreep("claimer", "claimer", 10, 10, room);
    // 模拟历史推进：旧 key + 已推进的游标。
    ensureCreepMovementState(creep.name).travelState = {
      targetRoom: "W1N2",
      stuckTicks: 0,
      cachedPathCursor: 3,
      cachedPathKey: "v1-stale-key",
    };
    const path = setupCachedPath(storedPositions([
      [10, 10, "W1N1"],
      [11, 10, "W1N1"],
    ]));

    const result = moveToTargetRoom(creep, "W1N2", "W1N1|W1N2");

    // 新路径的下一步是 (11,10)（RIGHT），而不是任何旧游标推算出的位置。
    expect(result).toBe(OK);
    expect(creep.move).toHaveBeenCalledWith(RIGHT);
    expect(creep.move).not.toHaveBeenCalledWith(BOTTOM);
    expect(getCreepMovementState(creep.name)?.travelState?.cachedPathKey).toBe(path.key);
  });

  it("invalidates the cached path when a newly built structure blocks the next step", () => {
    const room = makeVisibleRoom();
    (room as unknown as { find: jest.Mock }).find = jest.fn((findConstant: number) => {
      if (findConstant === FIND_STRUCTURES) {
        // 缓存下一步 (10,11) 上新建了不可通行结构。
        return [{ structureType: STRUCTURE_WALL, pos: new MockRoomPosition(10, 11, "W1N1") }];
      }
      return [];
    });
    const creep = createCreep("claimer", "claimer", 10, 10, room);
    (creep.pos as unknown as { findClosestByPath: jest.Mock }).findClosestByPath = jest.fn(() => null);
    (creep.pos as unknown as { findClosestByRange: jest.Mock }).findClosestByRange = jest.fn(() => null);
    setupCachedPath(storedPositions([
      [10, 10, "W1N1"],
      [10, 11, "W1N1"],
      [10, 12, "W1N1"],
    ]));

    moveToTargetRoom(creep, "W1N2", "W1N1|W1N2");

    expect(creep.move).not.toHaveBeenCalledWith(BOTTOM);
    expect(Memory.data?.colonization?.W1N2?.cachedTravelPath).toBeUndefined();
    expect((global as PathFinderGlobal).PathFinder?.search).toHaveBeenCalled();
  });
});
