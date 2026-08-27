/**
 * 跨 tick 缓存回归测试：CostMatrix 拓扑指纹复用、MovePath cursor、
 * ERR_BUSY soft-stuck。对应任务书阶段 B（移动系统优化）。
 */
import {
  getRoomBaseCostMatrixBuildCountForTest,
  moveToTarget,
} from "@/movement/pathing";
import { clearRoomBaseCostMatrixCacheForTest } from "@/movement/pathing";
import { clearRoomTopologyRevisionCacheForTest } from "@/movement/roomTopologyRevision";
import { clearCreepMovementStateForTest, getCreepMovementState } from "@/movement/creepState";
import { clearMovementAnalyticsForTest, getMovementAnalyticsForTest } from "@/movement/metrics";
import { clearRoutingCachesForTest, getTravelMatrixBuildCountForTest, moveToTargetRoom } from "@/movement/routing";
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

function setupGlobals(): void {
  setupRoomPositionGlobal();
  setupPathFinderGlobal(RealCostMatrix as unknown as new () => CostMatrix);
  setDefaultMapMocks();
}

function advanceTick(): void {
  Game.time += 1;
}

const CORRIDOR_STEPS: Array<{ x: number; y: number; direction: DirectionConstant }> = [
  { x: 11, y: 10, direction: RIGHT },
  { x: 12, y: 10, direction: RIGHT },
  { x: 13, y: 10, direction: RIGHT },
  { x: 14, y: 10, direction: RIGHT },
  { x: 15, y: 10, direction: RIGHT },
];

interface Harness {
  room: Room;
  creep: Creep;
  structures: Array<{ structureType: string; pos: { x: number; y: number } }>;
  sites: Array<{ structureType: string; my: boolean; pos: { x: number; y: number } }>;
  creeps: Creep[];
  findPathTo: jest.Mock;
  capturedMatrices: CostMatrix[];
}

function wireFindPathTo(creep: Creep, harness?: Harness): jest.Mock {
  const captured = harness?.capturedMatrices ?? [];
  const impl = jest.fn(
    (
      _target: RoomPosition,
      opts: { costCallback?: (roomName: string, matrix: CostMatrix) => CostMatrix },
    ) => {
      if (opts.costCallback) {
        const matrix = opts.costCallback(creep.room.name, new RealCostMatrix() as unknown as CostMatrix);
        captured.push(matrix);
      }
      return CORRIDOR_STEPS.map((step) => ({ ...step, dx: 1, dy: 0 })) as PathStep[];
    },
  );
  (creep.pos as unknown as Record<string, unknown>).findPathTo = impl;
  return impl;
}

function relocate(creep: Creep, x: number, y: number): void {
  const pos = new MockRoomPosition(x, y, creep.room.name) as unknown as Record<string, unknown>;
  creep.pos = pos as unknown as RoomPosition;
}

/** 把 harness 的 findPathTo 桩重新挂到（relocate 替换过的）当前位置上。 */
function rewire(harness: Harness): void {
  (harness.creep.pos as unknown as Record<string, unknown>).findPathTo = harness.findPathTo;
}

function addSecondCreep(harness: Harness, name = "second"): { creep: Creep; findPathTo: jest.Mock } {
  const creep = createCreep(name, "worker", 10, 10, harness.room);
  harness.creeps.push(creep);
  Game.creeps[name] = creep;
  return { creep, findPathTo: wireFindPathTo(creep, harness) };
}

function buildHarness(): Harness {
  const structures: Array<{ structureType: string; pos: { x: number; y: number } }> = [];
  const sites: Array<{ structureType: string; my: boolean; pos: { x: number; y: number } }> = [];
  const creeps: Creep[] = [];
  const room = createRoom("W1N1", creeps);
  const creep = createCreep("mover", "worker", 10, 10, room);
  creeps.push(creep);
  Game.creeps[creep.name] = creep;

  room.find = jest.fn((findConstant: number) => {
    switch (findConstant) {
      case FIND_STRUCTURES:
      case FIND_MY_STRUCTURES:
        return structures;
      case FIND_MY_CREEPS:
        return creeps;
      case FIND_CONSTRUCTION_SITES:
        return sites;
      default:
        return [];
    }
  }) as unknown as Room["find"];

  const capturedMatrices: CostMatrix[] = [];
  const harness: Harness = { room, creep, structures, sites, creeps, findPathTo: jest.fn(), capturedMatrices };
  harness.findPathTo = wireFindPathTo(creep, harness);
  return harness;
}

/** 只留 (x,y) 一格可走，迫使占据该格的 blocker 无法被推开 → ERR_BUSY。 */
function wallAllExcept(x: number, y: number): void {
  (Game.map.getRoomTerrain as unknown) = jest.fn(() => ({
    get: (px: number, py: number) => (px === x && py === y ? 0 : TERRAIN_MASK_WALL),
  })) as unknown as GameMap["getRoomTerrain"];
}

function restorePlains(): void {
  (Game.map.getRoomTerrain as unknown) = jest.fn(() => ({ get: () => 0 })) as unknown as GameMap["getRoomTerrain"];
}

function addTarget(targetX = 15): RoomPosition {
  return new MockRoomPosition(targetX, 10, "W1N1") as unknown as RoomPosition;
}

describe("pathing cross-tick caching", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearCreepMovementStateForTest();
    clearMovementAnalyticsForTest();
    clearRoomBaseCostMatrixCacheForTest();
    clearRoomTopologyRevisionCacheForTest();
    clearRoutingCachesForTest();
    advanceTick();
    Game.rooms = {};
    Game.creeps = {};
    Game.powerCreeps = {};
    setupGlobals();
    (getSourceContainerPositionsForRoom as jest.Mock).mockReturnValue([]);
  });

  it("缓存路径在下一 tick 仍有效时不再次调用 findPathTo", () => {
    const harness = buildHarness();
    const target = addTarget();

    expect(moveToTarget(harness.creep, target, 0)).toBe(OK);
    expect(harness.findPathTo).toHaveBeenCalledTimes(1);

    relocate(harness.creep, 11, 10);
    rewire(harness);
    advanceTick();
    expect(moveToTarget(harness.creep, target, 0)).toBe(OK);
    expect(harness.findPathTo).toHaveBeenCalledTimes(1);
    expect(getMovementAnalyticsForTest().totals.pathCacheHits).toBeGreaterThanOrEqual(1);
  });

  it("同一房间相同静态布局跨 tick 复用基础矩阵", () => {
    const harness = buildHarness();
    moveToTarget(harness.creep, addTarget(), 0);
    expect(getRoomBaseCostMatrixBuildCountForTest()).toBe(1);

    // 第二个 creep 走不同目标，强制重新经过 costCallback 访问矩阵缓存。
    const second = addSecondCreep(harness);
    advanceTick();
    moveToTarget(second.creep, addTarget(14), 0);
    expect(second.findPathTo).toHaveBeenCalledTimes(1);
    expect(getRoomBaseCostMatrixBuildCountForTest()).toBe(1);
  });

  it("拓扑 revision 变化（新增结构）后矩阵重新构建", () => {
    const harness = buildHarness();
    moveToTarget(harness.creep, addTarget(), 0);
    expect(getRoomBaseCostMatrixBuildCountForTest()).toBe(1);

    harness.structures.push({ structureType: STRUCTURE_WALL, pos: { x: 20, y: 20 } });
    const second = addSecondCreep(harness);
    advanceTick();
    moveToTarget(second.creep, addTarget(14), 0);
    expect(getRoomBaseCostMatrixBuildCountForTest()).toBe(2);
  });

  it("拓扑 revision 变化（新增自家工地）后矩阵重新构建", () => {
    const harness = buildHarness();
    moveToTarget(harness.creep, addTarget(), 0);

    harness.sites.push({ structureType: STRUCTURE_EXTENSION, my: true, pos: { x: 20, y: 21 } });
    const second = addSecondCreep(harness);
    advanceTick();
    moveToTarget(second.creep, addTarget(14), 0);
    expect(getRoomBaseCostMatrixBuildCountForTest()).toBe(2);
  });

  it("RCL 变化后矩阵重新构建", () => {
    const harness = buildHarness();
    moveToTarget(harness.creep, addTarget(), 0);
    expect(getRoomBaseCostMatrixBuildCountForTest()).toBe(1);

    (harness.room.controller as { level?: number }).level = 4;
    const second = addSecondCreep(harness);
    advanceTick();
    moveToTarget(second.creep, addTarget(14), 0);
    expect(getRoomBaseCostMatrixBuildCountForTest()).toBe(2);
  });

  it("RoomPlanner savedAt 变化后矩阵重新构建", () => {
    const harness = buildHarness();
    Memory.data = Memory.data ?? {};
    Memory.data.roomPlanner = { W1N1: { layout: {}, timestamp: Game.time, savedAt: 10 } } as never;
    moveToTarget(harness.creep, addTarget(), 0);
    expect(getRoomBaseCostMatrixBuildCountForTest()).toBe(1);

    Memory.data.roomPlanner!.W1N1!.savedAt = 99;
    const second = addSecondCreep(harness);
    advanceTick();
    moveToTarget(second.creep, addTarget(14), 0);
    expect(getRoomBaseCostMatrixBuildCountForTest()).toBe(2);
  });

  it("TTL 到期后即使 revision 未变也会重新构建", () => {
    const harness = buildHarness();
    moveToTarget(harness.creep, addTarget(), 0);
    expect(getRoomBaseCostMatrixBuildCountForTest()).toBe(1);

    Game.time += 101;
    const second = addSecondCreep(harness);
    moveToTarget(second.creep, addTarget(14), 0);
    expect(getRoomBaseCostMatrixBuildCountForTest()).toBe(2);
  });

  it("PathFinder 回调拿到的是 clone，修改它不会污染缓存原件", () => {
    const harness = buildHarness();
    moveToTarget(harness.creep, addTarget(), 0);
    const first = harness.capturedMatrices[0];
    first.set(5, 5, 0xff);
    expect(first.get(5, 5)).toBe(0xff);

    const second = addSecondCreep(harness);
    advanceTick();
    moveToTarget(second.creep, addTarget(14), 0);
    const secondMatrix = second.findPathTo.mock.calls[0][1] as unknown as {
      costCallback: (roomName: string, matrix: CostMatrix) => CostMatrix;
    };
    void secondMatrix;
    expect(harness.capturedMatrices[1].get(5, 5)).toBe(0);
    expect(getRoomBaseCostMatrixBuildCountForTest()).toBe(1);
  });

  it("cursor 随正常前进递增", () => {
    const harness = buildHarness();
    const target = addTarget();

    moveToTarget(harness.creep, target, 0);
    // 新路径创建后立即 follow 一次：最近步恢复分支把 cursor 置为 0。
    expect(getCreepMovementState(harness.creep)?.movePathState?.cursor).toBe(0);

    relocate(harness.creep, 11, 10);
    rewire(harness);
    advanceTick();
    moveToTarget(harness.creep, target, 0);
    expect(getCreepMovementState(harness.creep)?.movePathState?.cursor).toBe(0);

    relocate(harness.creep, 12, 10);
    rewire(harness);
    advanceTick();
    moveToTarget(harness.creep, target, 0);
    expect(getCreepMovementState(harness.creep)?.movePathState?.cursor).toBe(1);

    relocate(harness.creep, 13, 10);
    rewire(harness);
    advanceTick();
    moveToTarget(harness.creep, target, 0);
    expect(getCreepMovementState(harness.creep)?.movePathState?.cursor).toBe(2);
  });

  it("creep 被推离路径后可以从邻近位置恢复", () => {
    const harness = buildHarness();
    const target = addTarget();

    moveToTarget(harness.creep, target, 0);
    relocate(harness.creep, 11, 11);
    rewire(harness);

    advanceTick();
    expect(moveToTarget(harness.creep, target, 0)).toBe(OK);
    // 未重新寻路，走的是最近路径步恢复分支。
    expect(harness.findPathTo).toHaveBeenCalledTimes(1);
    const state = getCreepMovementState(harness.creep)?.movePathState;
    expect(state).toBeDefined();
    expect(state?.cursor).toBeGreaterThanOrEqual(0);
  });

  it("单次 ERR_BUSY 保留路径且不触发重新寻路", () => {
    const harness = buildHarness();
    const blocker = createCreep("blocker", "worker", 11, 10, harness.room);
    const target = addTarget();

    // tick1：开阔地形下推开 blocker 成功前进。
    expect(moveToTarget(harness.creep, target, 0)).toBe(OK);
    expect(harness.findPathTo).toHaveBeenCalledTimes(1);

    // blocker 就位并把周围全部封死（含 mover 自己的格子，防止换位让路）。
    harness.creeps.push(blocker);
    Game.creeps[blocker.name] = blocker;
    wallAllExcept(11, 10);

    advanceTick();
    expect(moveToTarget(harness.creep, target, 0)).toBe(ERR_BUSY);
    expect(harness.findPathTo).toHaveBeenCalledTimes(1);
    // 路径仍被保留，等待暂时性阻塞解除。
    expect(getCreepMovementState(harness.creep)?.movePathState).toBeDefined();

    // 阻塞解除后下一 tick 直接沿缓存路径继续，无需重新寻路。
    restorePlains();
    advanceTick();
    expect(moveToTarget(harness.creep, target, 0)).toBe(OK);
    expect(harness.findPathTo).toHaveBeenCalledTimes(1);
  });

  it("连续阻塞达到阈值后强制绕开 creep 重新寻路", () => {
    const harness = buildHarness();
    const blocker = createCreep("blocker", "worker", 11, 10, harness.room);
    const target = addTarget();

    moveToTarget(harness.creep, target, 0);
    harness.creeps.push(blocker);
    Game.creeps[blocker.name] = blocker;
    wallAllExcept(11, 10);

    // tick 2/3：ERR_BUSY，无位置进展，stuckTicks 1/2。
    advanceTick();
    expect(moveToTarget(harness.creep, target, 0)).toBe(ERR_BUSY);
    advanceTick();
    expect(moveToTarget(harness.creep, target, 0)).toBe(ERR_BUSY);
    expect(harness.findPathTo).toHaveBeenCalledTimes(1);

    // tick 4：stuckTicks 达到 3，路径失效并重新寻路（ignoreCreeps 强制关闭）。
    advanceTick();
    moveToTarget(harness.creep, target, 0);
    expect(harness.findPathTo).toHaveBeenCalledTimes(2);
    expect((harness.findPathTo.mock.calls[1][1] as { ignoreCreeps?: boolean }).ignoreCreeps).toBe(false);
    expect(getMovementAnalyticsForTest().totals.pathRepaths).toBe(2);
  });

  it("global reset 后状态丢失但仍能重新寻路并正常移动", () => {
    const harness = buildHarness();
    const target = addTarget();

    moveToTarget(harness.creep, target, 0);
    expect(harness.findPathTo).toHaveBeenCalledTimes(1);

    // 模拟 global reset：heap 状态清空，cursor/movePathState 全部丢失。
    clearCreepMovementStateForTest();
    relocate(harness.creep, 12, 10);
    rewire(harness);
    advanceTick();

    expect(moveToTarget(harness.creep, target, 0)).toBe(OK);
    expect(harness.findPathTo).toHaveBeenCalledTimes(2);
    // 重寻路后 creep 位于 (12,10)=steps[1]，立即 follow 时精确命中并把 cursor 推进到 1。
    expect(getCreepMovementState(harness.creep)?.movePathState?.cursor).toBe(1);
  });

  it("routing 跨房矩阵跨 tick 复用且拓扑变化后重建", () => {
    const harness = buildHarness();
    // reusePath:0 + ignoreCreeps:false 关闭 segment 缓存，每次都经
    // PathFinder.search → roomCallback 访问 travelMatrixCache。
    const travelOptions = { ignoreCreeps: false, reusePath: 0 };
    (global as unknown as { PathFinder: { search: unknown } }).PathFinder.search = jest.fn(
      (
        _origin: RoomPosition,
        _goal: unknown,
        opts: { roomCallback: (roomName: string) => boolean | CostMatrix },
      ) => {
        // 像 PathFinder 引擎一样为途经房间调用 roomCallback，驱动矩阵构建/命中。
        opts.roomCallback(harness.room.name);
        return {
          path: [new MockRoomPosition(11, 10, harness.room.name) as unknown as RoomPosition],
          incomplete: false,
          ops: 1,
          cost: 1,
        };
      },
    );
    (harness.room as unknown as Record<string, unknown>).findExitTo = jest.fn(() => RIGHT);

    const traveler = createCreep("traveler", "scout", 10, 10, harness.room);
    harness.creeps.push(traveler);
    Game.creeps[traveler.name] = traveler;
    (harness.room.controller as unknown as { pos: { x: number; y: number } }).pos = { x: 25, y: 25 };
    Game.map.describeExits = jest.fn(() => ({ [RIGHT]: "W2N1" })) as unknown as GameMap["describeExits"];
    Game.map.findRoute = jest.fn(() => [{ exit: RIGHT, room: "W2N1" }]) as unknown as GameMap["findRoute"];

    expect(moveToTargetRoom(traveler, "W2N1", undefined, travelOptions)).toBe(OK);
    expect(getTravelMatrixBuildCountForTest()).toBe(1);

    advanceTick();
    expect(moveToTargetRoom(traveler, "W2N1", undefined, travelOptions)).toBe(OK);
    expect(getTravelMatrixBuildCountForTest()).toBe(1);

    harness.structures.push({ structureType: STRUCTURE_WALL, pos: { x: 20, y: 20 } });
    advanceTick();
    expect(moveToTargetRoom(traveler, "W2N1", undefined, travelOptions)).toBe(OK);
    expect(getTravelMatrixBuildCountForTest()).toBe(2);
  });
});
