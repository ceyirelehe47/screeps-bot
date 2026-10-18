/**
 * 跨 tick 缓存回归测试：CostMatrix 拓扑指纹复用、MovePath cursor、
 * ERR_BUSY soft-stuck。对应任务书阶段 B（移动系统优化）。
 */
import {
  getRoomBaseCostMatrixBuildCountForTest,
  getRoomStaticMatrix,
  moveToTarget,
} from "@/movement/pathing";
import { clearRoomBaseCostMatrixCacheForTest } from "@/movement/pathing";
import { clearRoomTopologyRevisionCacheForTest } from "@/movement/roomTopologyRevision";
import { clearCreepMovementStateForTest, getCreepMovementState } from "@/movement/creepState";
import { clearMovementAnalyticsForTest, getMovementAnalyticsForTest } from "@/movement/metrics";
import { clearRoutingCachesForTest, getTravelMatrixBuildCountForTest, getCachedStaticTravelMatrix } from "@/movement/routing";
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

jest.mock("@/runtime/sourceWorkPosition", () => ({
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
  hostileCreeps: Creep[];
  hostilePowerCreeps: PowerCreep[];
  search: jest.Mock;
  capturedMatrices: CostMatrix[];
}

function wirePathSearch(creep: Creep, harness?: Harness): jest.Mock {
  const captured = harness?.capturedMatrices ?? [];
  const impl = jest.fn((origin: RoomPosition, _goals: Parameters<PathFinder["search"]>[1], options: PathFinderOpts) => {
    const matrix = options.roomCallback?.(origin.roomName);
    if (matrix && matrix !== true) captured.push(matrix);
    return { path: CORRIDOR_STEPS.map(step => new RoomPosition(step.x, step.y, origin.roomName)), ops: 5, cost: 10, incomplete: false };
  });
  const previous = jest.mocked(PathFinder.search).getMockImplementation()!;
  jest.mocked(PathFinder.search).mockImplementation((origin, goals, options) =>
    origin === creep.pos ? impl(origin, goals, options!) : previous(origin, goals, options));
  return impl;
}

function relocate(creep: Creep, x: number, y: number): void {
  const pos = new MockRoomPosition(x, y, creep.room.name) as unknown as Record<string, unknown>;
  creep.pos = pos as unknown as RoomPosition;
}


function addSecondCreep(harness: Harness, name = "second"): { creep: Creep; search: jest.Mock } {
  const creep = createCreep(name, "worker", 10, 10, harness.room);
  harness.creeps.push(creep);
  Game.creeps[name] = creep;
  return { creep, search: wirePathSearch(creep, harness) };
}

function buildHarness(): Harness {
  const structures: Array<{ structureType: string; pos: { x: number; y: number } }> = [];
  const sites: Array<{ structureType: string; my: boolean; pos: { x: number; y: number } }> = [];
  const creeps: Creep[] = [];
  const hostileCreeps: Creep[] = [];
  const hostilePowerCreeps: PowerCreep[] = [];
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
      case FIND_HOSTILE_CREEPS:
        return hostileCreeps;
      case FIND_HOSTILE_POWER_CREEPS:
        return hostilePowerCreeps;
      case FIND_CONSTRUCTION_SITES:
        return sites;
      default:
        return [];
    }
  }) as unknown as Room["find"];

  const capturedMatrices: CostMatrix[] = [];
  const harness: Harness = {
    room, creep, structures, sites, creeps, hostileCreeps, hostilePowerCreeps,
    search: jest.fn(), capturedMatrices,
  };
  harness.search = wirePathSearch(creep, harness);
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

  it("缓存路径在下一 tick 仍有效时不再次调用 search", () => {
    const harness = buildHarness();
    const target = addTarget();

    expect(moveToTarget(harness.creep, target, 0)).toBe(OK);
    expect(harness.search).toHaveBeenCalledTimes(1);

    relocate(harness.creep, 11, 10);
    advanceTick();
    expect(moveToTarget(harness.creep, target, 0)).toBe(OK);
    expect(harness.search).toHaveBeenCalledTimes(1);
    expect(getMovementAnalyticsForTest().totals.pathCacheHits).toBeGreaterThanOrEqual(1);
  });

  it("同一房间不同地形成本在同 tick 与跨 tick 复用基础矩阵", () => {
    const harness = buildHarness();
    const firstCosts = { plainCost: 2, swampCost: 8 };
    moveToTarget(harness.creep, addTarget(), 0, firstCosts);
    expect(harness.search.mock.calls[0][2]).toEqual(expect.objectContaining(firstCosts));
    expect(getRoomBaseCostMatrixBuildCountForTest()).toBe(1);
    harness.capturedMatrices[0].set(5, 5, 0xff);
    expect(getRoomStaticMatrix(harness.room.name).get(5, 5)).toBe(0);

    // 同 tick 使用不同成本重新经过 callback，静态矩阵复用但 clone 独立。
    const sameTick = addSecondCreep(harness, "same-tick");
    const sameTickCosts = { plainCost: 1, swampCost: 5 };
    moveToTarget(sameTick.creep, addTarget(14), 0, sameTickCosts);
    expect(sameTick.search).toHaveBeenCalledTimes(1);
    expect(sameTick.search.mock.calls[0][2]).toEqual(expect.objectContaining(sameTickCosts));
    expect(harness.capturedMatrices[1].get(5, 5)).toBe(0);
    expect(getRoomBaseCostMatrixBuildCountForTest()).toBe(1);
    harness.capturedMatrices[1].set(6, 6, 0xff);

    const nextTick = addSecondCreep(harness, "next-tick");
    const nextTickCosts = { plainCost: 3, swampCost: 12 };
    advanceTick();
    moveToTarget(nextTick.creep, addTarget(13), 0, nextTickCosts);
    expect(nextTick.search).toHaveBeenCalledTimes(1);
    expect(nextTick.search.mock.calls[0][2]).toEqual(expect.objectContaining(nextTickCosts));
    expect(harness.capturedMatrices[2].get(5, 5)).toBe(0);
    expect(harness.capturedMatrices[2].get(6, 6)).toBe(0);
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
    const secondMatrix = second.search.mock.calls[0][2] as unknown as {
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
    advanceTick();
    moveToTarget(harness.creep, target, 0);
    expect(getCreepMovementState(harness.creep)?.movePathState?.cursor).toBe(0);

    relocate(harness.creep, 12, 10);
    advanceTick();
    moveToTarget(harness.creep, target, 0);
    expect(getCreepMovementState(harness.creep)?.movePathState?.cursor).toBe(1);

    relocate(harness.creep, 13, 10);
    advanceTick();
    moveToTarget(harness.creep, target, 0);
    expect(getCreepMovementState(harness.creep)?.movePathState?.cursor).toBe(2);
  });

  it("creep 被推离路径后可以从邻近位置恢复", () => {
    const harness = buildHarness();
    const target = addTarget();

    moveToTarget(harness.creep, target, 0);
    relocate(harness.creep, 11, 11);

    advanceTick();
    expect(moveToTarget(harness.creep, target, 0)).toBe(OK);
    // 未重新寻路，走的是最近路径步恢复分支。
    expect(harness.search).toHaveBeenCalledTimes(1);
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
    expect(harness.search).toHaveBeenCalledTimes(1);

    // blocker 就位并把周围全部封死（含 mover 自己的格子，防止换位让路）。
    harness.creeps.push(blocker);
    Game.creeps[blocker.name] = blocker;
    wallAllExcept(11, 10);

    advanceTick();
    expect(moveToTarget(harness.creep, target, 0)).toBe(ERR_BUSY);
    expect(harness.search).toHaveBeenCalledTimes(1);
    // 路径仍被保留，等待暂时性阻塞解除。
    expect(getCreepMovementState(harness.creep)?.movePathState).toBeDefined();

    // 阻塞解除后下一 tick 直接沿缓存路径继续，无需重新寻路。
    restorePlains();
    advanceTick();
    expect(moveToTarget(harness.creep, target, 0)).toBe(OK);
    expect(harness.search).toHaveBeenCalledTimes(1);
  });

  it("连续阻塞后重新寻路叠加动态障碍且不污染静态缓存", () => {
    const harness = buildHarness();
    const blocker = createCreep("blocker", "worker", 11, 10, harness.room);
    const target = addTarget();

    moveToTarget(harness.creep, target, 0);
    harness.creeps.push(blocker);
    Game.creeps[blocker.name] = blocker;
    harness.hostileCreeps.push({
      name: "hostile-creep",
      pos: new MockRoomPosition(12, 11, harness.room.name),
    } as unknown as Creep);
    harness.hostilePowerCreeps.push({
      name: "hostile-power",
      pos: new MockRoomPosition(13, 11, harness.room.name),
    } as unknown as PowerCreep);
    Game.powerCreeps = {
      "my-power": {
        name: "my-power",
        pos: new MockRoomPosition(14, 11, harness.room.name),
        ticksToLive: 1_000,
        room: harness.room,
      } as unknown as PowerCreep,
    };
    wallAllExcept(11, 10);

    // tick 2/3：ERR_BUSY，无位置进展，stuckTicks 1/2。
    advanceTick();
    expect(moveToTarget(harness.creep, target, 0)).toBe(ERR_BUSY);
    advanceTick();
    expect(moveToTarget(harness.creep, target, 0)).toBe(ERR_BUSY);
    expect(harness.search).toHaveBeenCalledTimes(1);

    // tick 4：stuckTicks 达到 3，路径失效并重新寻路（ignoreCreeps 强制关闭）。
    advanceTick();
    moveToTarget(harness.creep, target, 0);
    expect(harness.search).toHaveBeenCalledTimes(2);
    expect(getMovementAnalyticsForTest().totals.pathRepaths).toBe(2);
    // 检查实际 callback 矩阵，不能只检查 search 收到的 ignoreCreeps。
    const recoveryMatrix = harness.capturedMatrices[1];
    expect(recoveryMatrix.get(11, 10)).toBe(0xfe);
    expect(recoveryMatrix.get(12, 11)).toBe(0xfe);
    expect(recoveryMatrix.get(13, 11)).toBe(0xfe);
    expect(recoveryMatrix.get(14, 11)).toBe(0xfe);
    expect(recoveryMatrix.get(10, 10)).toBe(0);
    const staticMatrix = getRoomStaticMatrix(harness.room.name);
    expect(staticMatrix.get(11, 10)).toBe(0);
    expect(staticMatrix.get(12, 11)).toBe(0);
    expect(staticMatrix.get(13, 11)).toBe(0);
    expect(staticMatrix.get(14, 11)).toBe(0);
    expect(getRoomBaseCostMatrixBuildCountForTest()).toBe(1);

    // 动态对象消失后换目标触发 callback，仍复用静态矩阵且原格恢复可走。
    harness.creeps.splice(1);
    delete Game.creeps[blocker.name];
    harness.hostileCreeps.length = 0;
    harness.hostilePowerCreeps.length = 0;
    Game.powerCreeps = {};
    restorePlains();
    advanceTick();
    moveToTarget(harness.creep, addTarget(14), 0, { ignoreCreeps: false });
    expect(harness.search).toHaveBeenCalledTimes(3);
    const clearedMatrix = harness.capturedMatrices[2];
    expect(clearedMatrix.get(11, 10)).toBe(0);
    expect(clearedMatrix.get(12, 11)).toBe(0);
    expect(clearedMatrix.get(13, 11)).toBe(0);
    expect(clearedMatrix.get(14, 11)).toBe(0);
    expect(getRoomBaseCostMatrixBuildCountForTest()).toBe(1);
  });

  it("global reset 后状态丢失但仍能重新寻路并正常移动", () => {
    const harness = buildHarness();
    const target = addTarget();

    moveToTarget(harness.creep, target, 0);
    expect(harness.search).toHaveBeenCalledTimes(1);

    // 模拟 global reset：heap 状态清空，cursor/movePathState 全部丢失。
    clearCreepMovementStateForTest();
    relocate(harness.creep, 12, 10);
    advanceTick();

    expect(moveToTarget(harness.creep, target, 0)).toBe(OK);
    expect(harness.search).toHaveBeenCalledTimes(2);
    // 重寻路后 creep 位于 (12,10)=steps[1]，立即 follow 时精确命中并把 cursor 推进到 1。
    expect(getCreepMovementState(harness.creep)?.movePathState?.cursor).toBe(1);
  });

  it("routing 跨房矩阵跨 tick 复用且拓扑变化后重建", () => {
    const harness = buildHarness();
    const traveler = createCreep("traveler", "scout", 10, 10, harness.room);
    harness.creeps.push(traveler);
    Game.creeps[traveler.name] = traveler;
    (harness.room.controller as unknown as { pos: { x: number; y: number } }).pos = { x: 25, y: 25 };
    Game.map.describeExits = jest.fn(() => ({ [RIGHT]: "W2N1" })) as unknown as GameMap["describeExits"];
    Game.map.findRoute = jest.fn(() => [{ exit: RIGHT, room: "W2N1" }]) as unknown as GameMap["findRoute"];

    getCachedStaticTravelMatrix(harness.room.name);
    expect(getTravelMatrixBuildCountForTest()).toBe(1);

    advanceTick();
    getCachedStaticTravelMatrix(harness.room.name);
    expect(getTravelMatrixBuildCountForTest()).toBe(1);

    harness.structures.push({ structureType: STRUCTURE_WALL, pos: { x: 20, y: 20 } });
    advanceTick();
    getCachedStaticTravelMatrix(harness.room.name);
    expect(getTravelMatrixBuildCountForTest()).toBe(2);
  });
});
