import { searchRoomExitPath } from "@/movement/exitPath";
import { moveToTargetRoom, clearRoutingCachesForTest } from "@/movement/routing";
import { clearCreepMovementStateForTest, getCreepMovementState } from "@/movement/creepState";
import { createCreep, createRoom, resetRuntimeServices, setupPathFinderGlobal, setupRoomPositionGlobal, setDefaultMapMocks } from "@mock/movement";
import { searchSingleRoom } from "@mock/roomPathFinder";
import * as safeZoneHelpers from "@/runtime/safeZoneHelpers";
import * as safeZone from "@/runtime/safeZone";
import { clearMovementAnalyticsForTest, getMovementAnalyticsForTest } from "@/movement/metrics";

jest.mock("@/runtime/roomPlannerConstruction", () => ({ getSourceContainerPositionsForRoom: jest.fn(() => []) }));

describe("出口搜索的引擎语义边界", () => {
  beforeEach(() => {
    Game.time++; Game.rooms = {}; Game.creeps = {}; Game.spawns = {}; Game.powerCreeps = {};
    Memory.cfg = undefined; Memory.data = undefined; Memory.runtime = {};
    resetRuntimeServices(); clearRoutingCachesForTest(); clearCreepMovementStateForTest();
    clearMovementAnalyticsForTest();
    setupRoomPositionGlobal(); setupPathFinderGlobal(); setDefaultMapMocks();
    (PathFinder.search as jest.Mock).mockImplementation(searchSingleRoom);
    Game.map.describeExits = jest.fn(() => ({ [RIGHT]: "W0N1" }));
  });
  function unit(name = "traveler", role: CreepMemory["role"] = "remoteCarrier") {
    const room = Game.rooms.W1N1 ?? createRoom("W1N1");
    const creep = createCreep(name, role, 10, 10, room);
    Game.creeps[name] = creep;
    return creep;
  }
  it("安全区层在自定义成本之后生效，选择与路径都不越过许可格", () => {
    const creep = unit();
    const restrict = jest.spyOn(safeZoneHelpers, "shouldRestrictToSafeZone").mockReturnValue(true);
    const zone = jest.spyOn(safeZone, "getSafeZone").mockReturnValue(new Set(Array.from({ length: 40 }, (_, x) => (x + 10) * 50 + 10)));
    try {
      const selected = searchRoomExitPath(creep, RIGHT, { costCallback: (_name, matrix) => matrix });
      expect(selected.complete).toBe(true);
      expect(selected.path.every(pos => pos.y === 10)).toBe(true);
      const matrix = (PathFinder.search as jest.Mock).mock.calls[0][2].roomCallback(creep.room.name) as CostMatrix;
      expect(matrix.get(20, 11)).toBe(255);
      expect(matrix.get(20, 10)).toBeLessThan(255);
    } finally { restrict.mockRestore(); zone.mockRestore(); }
  });
  it("密集母房的 PB 两人都能绕过障碍发出移动意图，选路不再重复搜索", () => {
    const attacker = unit("attacker", "powerBankAttacker"), healer = unit("healer", "powerBankHealer");
    healer.pos = new RoomPosition(9, 10, healer.room.name);
    const options = { costCallback: (_room: string, matrix: CostMatrix) => {
      for (let y = 1; y < 49; y++) if (y !== 40) matrix.set(20, y, 255);
      return matrix;
    } };
    expect(moveToTargetRoom(attacker, "W0N1", "W1N1|W0N1", options)).toBe(OK);
    expect(moveToTargetRoom(healer, "W0N1", "W1N1|W0N1", options)).toBe(OK);
    expect(attacker.move).toHaveBeenCalledTimes(1); expect(healer.move).toHaveBeenCalledTimes(1);
    expect(PathFinder.search).toHaveBeenCalledTimes(2);
    const steps = getCreepMovementState(attacker)!.movePathState!.steps;
    expect(steps).toContainEqual({ x: 20, y: 40 });
    expect(steps.slice(0, -1).every(step => step.x > 0 && step.x < 49 && step.y > 0 && step.y < 49)).toBe(true);
  });
  it("只有错误边界走廊可达时，不把旧的宽松路线当作可执行路径", () => {
    const creep = unit();
    creep.pos = new RoomPosition(1, 10, creep.room.name);
    Game.map.getRoomTerrain = jest.fn(() => ({ get: (x: number, y: number) =>
      x === 1 && y === 10 || x === 0 && y >= 10 && y <= 20 || y === 20 ? 0 : TERRAIN_MASK_WALL })) as GameMap["getRoomTerrain"];
    const loose = searchSingleRoom(creep.pos, { pos: new RoomPosition(49, 20, creep.room.name), range: 0 }, { maxOps: 8000 });
    expect(loose.incomplete).toBe(false); expect(loose.path.some(pos => pos.x === 0)).toBe(true);
    expect(moveToTargetRoom(creep, "W0N1", "W1N1|W0N1")).toBe(ERR_NO_PATH);
    expect(creep.move).not.toHaveBeenCalled();
    expect(getCreepMovementState(creep)!.travelState!.rejectedTransitions?.["W1N1->W0N1"]).toBe(Game.time + 20);
  });
  it("搜索器报告预算耗尽时有界重试；半截路径继续推进，不缓存伪出口或排除跳转", () => {
    const creep = unit();
    (PathFinder.search as jest.Mock).mockImplementation((origin, goals, opts) => {
      const partial = searchSingleRoom(origin, goals, { ...opts, maxOps: 3 });
      expect(partial.incomplete).toBe(true);
      return { ...partial, ops: opts.maxOps };
    });
    expect(moveToTargetRoom(creep, "W0N1", "W1N1|W0N1")).toBe(OK);
    expect(PathFinder.search).toHaveBeenCalledTimes(2);
    expect((PathFinder.search as jest.Mock).mock.calls.map(call => call[2].maxOps)).toEqual([8000, 16000]);
    expect(creep.move).toHaveBeenCalledWith(RIGHT);
    expect(getCreepMovementState(creep)!.travelState).toMatchObject({ targetRoom: "W0N1" });
    expect(getCreepMovementState(creep)!.travelState!.exitTarget).toBeUndefined();
    expect(getCreepMovementState(creep)!.travelState!.rejectedTransitions).toBeUndefined();
  });
  it("静态穷尽的真实非空 partial 立即拒绝出口，不走向墙边也不逐 tick 重搜", () => {
    const creep = unit();
    const options = { costCallback: (_room: string, matrix: CostMatrix) => {
      for (let y = 0; y < 50; y++) matrix.set(30, y, 255);
      return matrix;
    } };
    expect(moveToTargetRoom(creep, "W0N1", "W1N1|W0N1", options)).toBe(ERR_NO_PATH);
    const returned = (PathFinder.search as jest.Mock).mock.results[0].value as PathFinderPath;
    expect(returned.incomplete).toBe(true);
    expect(returned.ops).toBeLessThan(8000);
    expect(returned.path.length).toBeGreaterThan(0);
    expect(returned.path[returned.path.length - 1].x).toBe(29);
    expect(creep.move).not.toHaveBeenCalled();
    expect(getCreepMovementState(creep)!.travelState!.rejectedTransitions?.["W1N1->W0N1"]).toBe(Game.time + 20);
    Game.time++;
    expect(moveToTargetRoom(creep, "W0N1", "W1N1|W0N1", options)).toBe(ERR_NO_PATH);
    expect(PathFinder.search).toHaveBeenCalledTimes(1);
    expect(getMovementAnalyticsForTest().totals).toMatchObject({ exitExhaustedStatic: 1, exitPartialPaths: 0 });
  });
  it("考虑动态 creep 的穷尽 partial 保留进展，不把暂时阻挡当成静态断路", () => {
    const creep = unit();
    const selected = searchRoomExitPath(creep, RIGHT, { ignoreCreeps: false, costCallback: (_room, matrix) => {
      for (let y = 0; y < 50; y++) matrix.set(30, y, 255);
      return matrix;
    } });
    expect(selected.complete).toBe(false); expect(selected.rejectTransition).toBe(false);
    expect(selected.path.length).toBeGreaterThan(0);
    expect(getMovementAnalyticsForTest().totals).toMatchObject({ exitExhaustedStatic: 0, exitPartialPaths: 1 });
  });
  it("空的预算失败和考虑 creep 的临时阻挡不封禁房间", () => {
    const creep = unit();
    (PathFinder.search as jest.Mock).mockImplementation((_origin, _goals, opts) => ({ path: [], cost: 0, incomplete: true, ops: opts.maxOps }));
    expect(searchRoomExitPath(creep, RIGHT, {})).toMatchObject({ rejectTransition: false, path: [] });
    (PathFinder.search as jest.Mock).mockReturnValue({ path: [], cost: 0, incomplete: true, ops: 1 });
    expect(searchRoomExitPath(creep, RIGHT, { ignoreCreeps: false })).toMatchObject({ rejectTransition: false });
    expect(searchRoomExitPath(creep, RIGHT, { ignoreCreeps: true })).toMatchObject({ rejectTransition: true });
  });
  it("A* 夹具按 maxOps 返回 incomplete，再增加预算可完成", () => {
    const creep = unit();
    const goal = { pos: new RoomPosition(49, 10, creep.room.name), range: 0 };
    const partial = searchSingleRoom(creep.pos, goal, { maxOps: 3 });
    expect(partial).toMatchObject({ incomplete: true, ops: 3 });
    expect(partial.path).toHaveLength(2);
    const complete = searchSingleRoom(creep.pos, goal, { maxOps: 8000 });
    expect(complete.incomplete).toBe(false);
    expect(complete.path[complete.path.length - 1]).toEqual(goal.pos);
  });
});
