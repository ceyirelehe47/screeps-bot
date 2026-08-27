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
import { getSourceContainerPositionsForRoom } from "@/runtime/roomPlannerConstruction";

jest.mock("@/runtime/roomPlannerConstruction", () => ({
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
    jest.spyOn(pos, "findPathTo").mockReturnValue([
      { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
    ] as PathStep[]);
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

    let capturedMatrix: RealCostMatrix | undefined;
    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(
      (_target: unknown, opts: { costCallback?: (roomName: string, matrix: CostMatrix) => CostMatrix }) => {
        capturedMatrix = opts.costCallback?.(
          room.name,
          new RealCostMatrix() as unknown as CostMatrix,
        ) as unknown as RealCostMatrix;
        return [{ x: 10, y: 11, dx: 0, dy: 1, direction: BOTTOM }];
      },
    );

    moveToTarget(
      creep,
      new MockRoomPosition(15, 10, room.name) as unknown as RoomPosition,
      1,
      { ignoreCreeps: false, reusePath: 0 },
    );

    expect(capturedMatrix?.get(11, 10)).toBe(0xfe);
    expect(capturedMatrix?.get(12, 10)).toBe(0xfe);
  });

  it("does not cache engine-written creep obstacles from the fallback matrix across ticks", () => {
    const room = createRoom("W1N1");
    const creep = createCreep("mover", "worker", 10, 10, room);
    const target = new MockRoomPosition(15, 10, room.name) as unknown as RoomPosition;
    const blocker = { x: 12, y: 10 };
    let ignoreCreepsOnLastSearch = true;
    let capturedMatrix: RealCostMatrix | undefined;
    let capturedFallback: RealCostMatrix | undefined;

    // 模拟真实引擎行为：ignoreCreeps=false 时引擎会把当前房间 creep 写入
    // 传给 costCallback 的 fallbackMatrix；ignoreCreeps=true 时不会。
    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(
      (
        _target: unknown,
        opts: {
          ignoreCreeps?: boolean;
          costCallback?: (roomName: string, matrix: CostMatrix) => CostMatrix;
        },
      ) => {
        const fallback = new RealCostMatrix() as unknown as CostMatrix;
        ignoreCreepsOnLastSearch = opts.ignoreCreeps ?? true;
        if (!ignoreCreepsOnLastSearch) {
          fallback.set(blocker.x, blocker.y, 0xfe);
        }
        capturedFallback = fallback as unknown as RealCostMatrix;
        capturedMatrix = opts.costCallback?.(room.name, fallback) as unknown as RealCostMatrix;
        return [{ x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT }];
      },
    );

    // 首 tick：引擎确实把 blocker 写进了 fallback matrix……
    moveToTarget(creep, target, 1, { ignoreCreeps: false, reusePath: 5 });
    expect(ignoreCreepsOnLastSearch).toBe(false);
    expect((capturedFallback as RealCostMatrix | undefined)?.get(blocker.x, blocker.y)).toBe(0xfe);
    // ……但静态缓存矩阵不得把它烘入：返回矩阵中 blocker 位置保持可通行。
    expect(capturedMatrix?.get(blocker.x, blocker.y)).toBeLessThan(0xfe);
    const buildsAfterFirstTick = getRoomBaseCostMatrixBuildCountForTest();

    // 次 tick：blocker 消失且 ignoreCreeps=true；矩阵缓存应命中（不重建），
    // 且复用的矩阵中 blocker 位置仍可通行（未被首 tick 的引擎写入污染）。
    Game.time += 1;
    moveToTarget(creep, target, 1, { ignoreCreeps: true, reusePath: 5 });
    expect(ignoreCreepsOnLastSearch).toBe(true);
    expect(getRoomBaseCostMatrixBuildCountForTest()).toBe(buildsAfterFirstTick);
    expect(capturedMatrix?.get(blocker.x, blocker.y)).toBeLessThan(0xfe);
  });
});
