/**
 * Tests for src/movement/pathing.ts
 *
 * Two categories:
 * - **Baseline tests**: verify current in-room path caching, stored path following,
 *   exit recovery, stuck-tick tracking, and moveToRemoteWorkTarget behavior.
 * - **Target-behavior tests**: encode the desired API for Task 3 (costCallback,
 *   cacheKey, cross-room guard). These tests are expected to FAIL before Task 3
 *   implements the features.
 */
import {
  clearRoomBaseCostMatrixCacheForTest,
  getRoomBaseCostMatrixBuildCountForTest,
  moveToTarget,
  getRoomStaticMatrix,
} from "@/movement/pathing";
import { clearCreepMovementStateForTest, getCreepMovementState } from "@/movement/creepState";
import { clearMovementAnalyticsForTest } from "@/movement/metrics";
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
import { getSourceContainerPositionsForRoom } from "@/runtime/sourceWorkPosition";
import { searchSingleRoom } from "@mock/roomPathFinder";

jest.mock("@/runtime/sourceWorkPosition", () => ({
  getSourceContainerPositionsForRoom: jest.fn(() => []),
}));

// ---------------------------------------------------------------------------
// Test setup helpers
// ---------------------------------------------------------------------------

function setupGlobals(costMatrixClass?: new () => CostMatrix): void {
  setupRoomPositionGlobal();
  setupPathFinderGlobal(costMatrixClass);
  setDefaultMapMocks();
}

function advanceTick(): void {
  Game.time += 1;
}

// ---------------------------------------------------------------------------
// Baseline tests: current behavior
// ---------------------------------------------------------------------------

describe("moveToTarget baseline", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearCreepMovementStateForTest();
    clearMovementAnalyticsForTest();
    clearRoomBaseCostMatrixCacheForTest();
    advanceTick();
    Game.rooms = {};
    Game.creeps = {};
    Game.powerCreeps = {};
    setupGlobals();
    (getSourceContainerPositionsForRoom as jest.Mock).mockReturnValue([]);
  });

  it("uses the shared stored-path follower for a Power Creep", () => {
    const room = createRoom("W1N1");
    const pos = new MockRoomPosition(10, 10, room.name);

    const powerCreep = {
      name: "operator",
      room,
      pos: pos as unknown as RoomPosition,
      ticksToLive: 1_000,
      powers: {},
      memory: {},
      move: jest.fn(() => OK),
    } as unknown as PowerCreep;
    Game.powerCreeps = { operator: powerCreep };

    const result = moveToTarget(
      powerCreep,
      new MockRoomPosition(15, 10, room.name) as unknown as RoomPosition,
      3,
    );

    expect(result).toBe(OK);
    expect(powerCreep.move).toHaveBeenCalledWith(RIGHT);
    expect(getCreepMovementState(powerCreep)?.pathingRequestedAt).toBe(Game.time);
    expect(getCreepMovementState(powerCreep)?.movePathState?.range).toBe(3);
    expect(getCreepMovementState(powerCreep.name)).toBeUndefined();
  });

  it("marks friendly and hostile creep positions as high-cost when dynamic avoidance is requested", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N1", creeps);
    const creep = createCreep("war-attacker", "meleeAttacker", 10, 10, room);
    const friendly = createCreep("friendly-blocker", "worker", 12, 10, room);
    const hostile = {
      name: "hostile-blocker",
      pos: new MockRoomPosition(11, 10, room.name),
    } as unknown as Creep;
    creeps.push(creep, friendly);
    Game.creeps[creep.name] = creep;
    Game.creeps[friendly.name] = friendly;
    room.find = jest.fn((findConstant: FindConstant) => {
      if (findConstant === FIND_MY_CREEPS) return creeps;
      if (findConstant === FIND_HOSTILE_CREEPS) return [hostile];
      return [];
    }) as Room["find"];

    let capturedMatrix: CostMatrix | undefined;
    jest.mocked(PathFinder.search).mockImplementation((origin, goals, opts) => {
      capturedMatrix = opts?.roomCallback?.(room.name) as CostMatrix;
      return searchSingleRoom(origin, goals, { ...opts, roomCallback: () => capturedMatrix! });
    });

    moveToTarget(
      creep,
      new MockRoomPosition(15, 10, room.name) as unknown as RoomPosition,
      1,
      { ignoreCreeps: false, reusePath: 0 },
    );

    expect(capturedMatrix?.get(11, 10)).toBe(0xfe);
    expect(capturedMatrix?.get(12, 10)).toBe(0xfe);
  });

  it("搜索器修改 callback 矩阵不会污染静态缓存或下一 tick 的动态障碍", () => {
    const room = createRoom("W1N1"), creep = createCreep("mover", "worker", 10, 10, room);
    const target = new MockRoomPosition(15, 10, room.name) as unknown as RoomPosition;
    let captured: CostMatrix | undefined, inject = true;
    jest.mocked(PathFinder.search).mockImplementation((origin, goals, opts) => {
      captured = opts?.roomCallback?.(room.name) as CostMatrix;
      if (inject) captured.set(12, 10, 0xfe);
      return searchSingleRoom(origin, goals, { ...opts, roomCallback: () => captured! });
    });
    moveToTarget(creep, target, 1, { ignoreCreeps: false, reusePath: 5 });
    expect(captured?.get(12, 10)).toBe(0xfe);
    expect(getRoomStaticMatrix(room.name).get(12, 10)).toBe(0);
    const builds = getRoomBaseCostMatrixBuildCountForTest();
    inject = false; Game.time++;
    moveToTarget(creep, target, 1, { ignoreCreeps: true, reusePath: 5 });
    expect(captured?.get(12, 10)).toBe(0);
    expect(getRoomBaseCostMatrixBuildCountForTest()).toBe(builds);
  });
});


describe("房内路径完整性", () => {
  beforeEach(() => { resetRuntimeServices(); clearCreepMovementStateForTest(); advanceTick(); Game.rooms = {}; Game.creeps = {}; setupGlobals(); });
  it("真实静态断路的非空 partial 在严格搜索中不产生移动", () => {
    const room = createRoom("W1N1"), creep = createCreep("strict-static", "meleeAttacker", 10, 10, room);
    jest.mocked(PathFinder.search).mockImplementation(searchSingleRoom);
    const costCallback = (_name: string, matrix: CostMatrix) => {
      for (let y = 0; y < 50; y++) matrix.set(13, y, 255);
      return matrix;
    };
    expect(moveToTarget(creep, new RoomPosition(15, 10, room.name), 0, { completeness: "complete", costCallback })).toBe(ERR_NO_PATH);
    const result = jest.mocked(PathFinder.search).mock.results[0].value as PathFinderPath;
    expect(result.incomplete).toBe(true); expect(result.path.length).toBeGreaterThan(0); expect(result.ops).toBeLessThan(8000);
    expect(creep.move).not.toHaveBeenCalled();
  });
  it("普通与严格搜索显式使用相同的道路地形成本，缓存键记录解析后的成本", () => {
    const room = createRoom("W1N1"), normal = createCreep("normal-road", "worker", 10, 10, room);
    const target = new RoomPosition(15, 10, room.name);
    const costCallback = (_name: string, matrix: CostMatrix) => {
      for (const [x, y] of [[10, 11], [11, 12], [12, 12], [13, 12], [14, 11], [15, 10]]) matrix.set(x, y, 1);
      return matrix;
    };

    expect(moveToTarget(normal, target, 0, { costCallback, cacheKey: "roads-v1" })).toBe(OK);
    expect(PathFinder.search).toHaveBeenCalledWith(normal.pos, { pos: target, range: 0 }, expect.objectContaining({ plainCost: 2, swampCost: 10 }));
    const normalState = getCreepMovementState(normal)!.movePathState!;
    expect(normalState.key).toContain(":s10:p2:");
    expect(normalState.steps.some(step => step.y === 12)).toBe(true);
    advanceTick();
    const strict = createCreep("strict-road", "meleeAttacker", 10, 10, room);
    jest.mocked(PathFinder.search).mockImplementation(searchSingleRoom);
    expect(moveToTarget(strict, target, 0, { completeness: "complete", costCallback, cacheKey: "roads-v1" })).toBe(OK);
    expect(PathFinder.search).toHaveBeenCalledWith(strict.pos, { pos: target, range: 0 }, expect.objectContaining({ plainCost: 2, swampCost: 10 }));
    expect(getCreepMovementState(strict)!.movePathState!.steps).toEqual(normalState.steps);
  });
  it("默认沿半截路径前进，严格模式不复用该缓存；完整已验证路径直接沿用", () => {
    const room = createRoom("W1N1");
    const creep = createCreep("partial-path", "worker", 10, 10, room);
    const find = jest.mocked(PathFinder.search).mockReturnValue({ path: [new RoomPosition(11, 10, room.name)], incomplete: true, ops: 1, cost: 2 });
    const target = new MockRoomPosition(15, 10, room.name) as unknown as RoomPosition;
    expect(moveToTarget(creep, target, 1)).toBe(OK);
    expect(getCreepMovementState(creep)?.movePathState?.expiresAt).toBe(Game.time + 2);
    expect(creep.move).toHaveBeenCalledWith(RIGHT);
    (creep.move as jest.Mock).mockClear();
    // 下一帧仍在 partial TTL 内；严格模式须拒用缓存，且没有上一帧的已受理 intent。
    advanceTick();
    expect(moveToTarget(creep, target, 1, { completeness: "complete" })).toBe(ERR_NO_PATH);
    expect(creep.move).not.toHaveBeenCalled();
    expect(getCreepMovementState(creep)?.movePathState).toBeUndefined();
    find.mockClear();
    const path = [11, 12, 13, 14].map(x => ({ x, y: 10, roomName: room.name }));
    expect(moveToTarget(creep, target, 1, { verifiedPath: path })).toBe(OK);
    expect(find).not.toHaveBeenCalled();
    expect(creep.move).toHaveBeenCalledWith(RIGHT);
  });

  it.each([100, 8000])("严格搜索区分穷尽与预算等待，不隐式重试或扩大 maxOps：%s", (ops) => {
    const room = createRoom("W1N1");
    const creep = createCreep("strict-path", "meleeAttacker", 10, 10, room);
    const target = new MockRoomPosition(15, 10, room.name) as unknown as RoomPosition;
    const path = [11, 12, 13, 14].map(x => new RoomPosition(x, 10, room.name));
    jest.mocked(PathFinder.search).mockReturnValueOnce({ path, incomplete: true, ops, cost: 8 })
      .mockReturnValue({ path, incomplete: false, ops: 9000, cost: 8 });
    expect(moveToTarget(creep, target, 1, { completeness: "complete" })).toBe(ops === 8000 ? ERR_BUSY : ERR_NO_PATH);
    expect(PathFinder.search).toHaveBeenCalledTimes(1);
    expect(PathFinder.search).toHaveBeenLastCalledWith(creep.pos, { pos: target, range: 1 }, expect.objectContaining({ maxOps: 8000 }));
    expect(creep.move).not.toHaveBeenCalled();
  });

  it("reusePath 为零时不借用先前缓存的完整路径", () => {
    const room = createRoom("W1N1"), creep = createCreep("no-reuse", "worker", 10, 10, room);
    const target = new RoomPosition(15, 10, room.name);
    expect(moveToTarget(creep, target, 1, { reusePath: 5 })).toBe(OK);
    jest.mocked(PathFinder.search).mockClear();
    moveToTarget(creep, target, 1, { reusePath: 0 });
    expect(PathFinder.search).toHaveBeenCalledTimes(1);
    expect(getCreepMovementState(creep)?.movePathState?.expiresAt).toBe(Game.time);
  });
});
