import { searchSingleRoom } from "@mock/roomPathFinder";
import { getNextTravelRoom, moveToTargetRoom, clearRoutingCachesForTest } from "@/movement/routing";
import { getPowerBankOwnedAvoidRooms, powerBankTransitOptions } from "@/runtime/powerBankTransit";
import { moveToTarget, buildRoomMovementMatrix, getRoomStaticMatrix, clearRoomBaseCostMatrixCacheForTest } from "@/movement/pathing";
import { clearCreepMovementStateForTest, ensureCreepMovementState, getCreepMovementState } from "@/movement/creepState";
import { MockRoomPosition, createRoom, createCreep, resetRuntimeServices, setupRoomPositionGlobal, setupPathFinderGlobal, setDefaultMapMocks } from "@mock/movement";

jest.mock("@/runtime/roomPlannerConstruction", () => ({ getSourceContainerPositionsForRoom: jest.fn(() => []) }));

describe("外出 creep 与常驻 creep 的统一房内寻路", () => {
  beforeEach(() => {
    Game.time += 1;
    Game.rooms = {}; Game.creeps = {}; Game.powerCreeps = {};
    Memory.data = {} as NonNullable<Memory["data"]>; Memory.runtime = {};
    resetRuntimeServices(); clearRoutingCachesForTest(); clearCreepMovementStateForTest();
    setupRoomPositionGlobal(); setupPathFinderGlobal(); setDefaultMapMocks();
    (PathFinder.search as jest.Mock).mockImplementation(searchSingleRoom);
    Game.map.describeExits = jest.fn((name: string) => name === "W1N1" ? { [RIGHT]: "W0N1", [TOP]: "W1N2" } : { [LEFT]: "W1N1" });
    Game.map.findRoute = jest.fn(() => [{ exit: RIGHT, room: "W0N1" }]);
  });

  function traveler(role = "remoteMiningCarrier") {
    const units: Creep[] = [];
    const room = createRoom("W1N1", units);
    room.findExitTo = jest.fn(() => RIGHT);
    const creep = createCreep("traveler", role as CreepMemory["role"], 10, 10, room);
    units.push(creep); Game.creeps[creep.name] = creep;
    const choose = jest.spyOn(creep.pos, "findClosestByPath").mockReturnValue(new MockRoomPosition(49, 10, room.name) as unknown as RoomPosition);
    const search = jest.spyOn(creep.pos, "findPathTo").mockImplementation((goal, options) => {
      options?.costCallback?.(room.name, new PathFinder.CostMatrix());
      // 本夹具只模拟无遮挡房间；成功结果必须完整抵达所请求的 range。
      const target = "pos" in goal ? goal.pos : goal;
      const path: PathStep[] = [];
      let { x, y } = creep.pos;
      while (Math.max(Math.abs(x - target.x), Math.abs(y - target.y)) > (options?.range ?? 1)) {
        const dx = Math.sign(target.x - x), dy = Math.sign(target.y - y);
        const direction = new MockRoomPosition(x, y, room.name).getDirectionTo(new MockRoomPosition(x + dx, y + dy, room.name));
        x += dx; y += dy; path.push({ x, y, dx, dy, direction });
      }
      return path;
    });
    return { room, creep, choose, search, units };
  }

  it("严格房间路线在稳定输入下复用，危险房变化时重新计算", () => {
    expect(getNextTravelRoom("W1N1", "W0N1", "W2N1|W0N1")).toBe("W0N1");
    expect(getNextTravelRoom("W1N1", "W0N1", "W2N1|W0N1")).toBe("W0N1");
    expect(Game.map.findRoute).toHaveBeenCalledTimes(1);
    Game.time++;
    expect(getNextTravelRoom("W1N1", "W0N1", "W2N1|W0N1")).toBe("W0N1");
    expect(Game.map.findRoute).toHaveBeenCalledTimes(1);
    getNextTravelRoom("W1N1", "W0N1", "W2N1|W0N1", ["W2N1"]);
    expect(Game.map.findRoute).toHaveBeenCalledTimes(2);
  });

  it.each(["remoteMiningCarrier", "remoteCarrier", "remoteWorker", "powerBankAttacker", "powerBankHealer", "scout", "depositHarvester"])("%s 走出口使用房内缓存和交通执行器", (role) => {
    const { creep, search } = traveler(role);
    expect(moveToTargetRoom(creep, "W0N1", "W1N1|W0N1")).toBe(OK);
    expect(search).not.toHaveBeenCalled();
    expect(PathFinder.search).toHaveBeenCalledWith(creep.pos, expect.any(Array), expect.objectContaining({ maxRooms: 1, maxOps: 8000 }));
    expect(creep.move).toHaveBeenCalledWith(RIGHT);
    expect(PathFinder.search).toHaveBeenCalledTimes(1);
    expect(getCreepMovementState(creep)?.movePathState?.targetX).toBe(49);
    expect((getCreepMovementState(creep)?.travelState as unknown as { multiRoomSegment?: unknown })?.multiRoomSegment).toBeUndefined();
  });

  it("有效有序路线重复选择与行军不调用原生findRoute或findExitTo", () => {
    const { creep, room } = traveler("powerBankAttacker");
    room.findExitTo = jest.fn((next) => { Game.map.findRoute(room.name, typeof next === "string" ? next : next.name); return RIGHT; });
    for (let i = 0; i < 5; i++) expect(getNextTravelRoom(room.name, "W0N1", "W1N1|W0N1")).toBe("W0N1");
    expect(moveToTargetRoom(creep, "W0N1", "W1N1|W0N1")).toBe(OK);
    expect(Game.map.findRoute).not.toHaveBeenCalled(); expect(room.findExitTo).not.toHaveBeenCalled();
    expect(creep.move).toHaveBeenCalledWith(RIGHT);
  });

  it("有序路线的下一房关闭时不发送跨房移动", () => {
    const { creep } = traveler();
    Game.map.getRoomStatus = jest.fn(() => ({ status: "closed" as const, timestamp: null }));
    expect(moveToTargetRoom(creep, "W0N1", "W1N1|W0N1")).toBe(ERR_NO_PATH);
    expect(creep.move).not.toHaveBeenCalled();
  });

  it("下一tick复用同一房内路径，位置变化才推进游标", () => {
    const { creep, search, choose } = traveler();
    moveToTargetRoom(creep, "W0N1", "W1N1|W0N1");
    Game.time += 1;
    creep.pos = new MockRoomPosition(11, 10, creep.room.name) as unknown as RoomPosition;
    moveToTargetRoom(creep, "W0N1", "W1N1|W0N1");
    expect(PathFinder.search).toHaveBeenCalledTimes(1);
    expect(search).not.toHaveBeenCalled(); expect(choose).not.toHaveBeenCalled();
    expect(getCreepMovementState(creep)?.movePathState?.cursor).toBe(0);
  });

  it("载货回到母房卸货时结束旧旅行，不再被旧出口目标影响", () => {
    const { creep, search } = traveler();
    moveToTargetRoom(creep, "W0N1", "W1N1|W0N1");
    Game.time += 1;
    moveToTarget(creep, new MockRoomPosition(20, 20, creep.room.name) as unknown as RoomPosition, 1);
    expect(getCreepMovementState(creep)?.travelState).toBeUndefined();
    expect(PathFinder.search).toHaveBeenLastCalledWith(creep.pos, { pos: expect.objectContaining({ x: 20, y: 20 }), range: 1 }, expect.objectContaining({ maxRooms: 1 }));
  });

  it("改为撤退时清理旧房内目标和旧私有segment，选择返程出口", () => {
    const { creep, room, search, choose } = traveler();
    moveToTargetRoom(creep, "W0N1", "W1N1|W0N1");
    const state = ensureCreepMovementState(creep);
    (state.travelState as unknown as { multiRoomSegment: unknown }).multiRoomSegment = { key: "stale" };
    room.findExitTo = jest.fn(() => TOP);
    Game.time += 1;
    moveToTargetRoom(creep, "W1N2", "W1N1|W1N2");
    expect(PathFinder.search).toHaveBeenLastCalledWith(creep.pos, expect.arrayContaining([expect.objectContaining({ pos: expect.objectContaining({ y: 0 }) })]), expect.objectContaining({ maxRooms: 1 }));
    expect(state.travelState?.targetRoom).toBe("W1N2");
    expect((state.travelState as unknown as { multiRoomSegment?: unknown })?.multiRoomSegment).toBeUndefined();
  });

  it("常驻与外出共用静态矩阵clone，动态障碍不污染缓存", () => {
    const { creep, room, units } = traveler();
    const blocker = createCreep("blocker", "worker", 11, 10, room); units.push(blocker);
    const base = getRoomStaticMatrix(room.name);
    const dynamic = buildRoomMovementMatrix(creep, room, room.name, base, { ignoreCreeps: false }, creep.pos);
    expect(dynamic.get(11, 10)).toBe(254);
    expect(getRoomStaticMatrix(room.name).get(11, 10)).not.toBe(254);
  });

  it("没有可达出口时报告无路，不发移动或改走未确认出口", () => {
    const { creep, search } = traveler();
    (PathFinder.search as jest.Mock).mockReturnValue({ path: [], incomplete: true, ops: 1, cost: 0 });
    expect(moveToTargetRoom(creep, "W0N1", "W1N1|W0N1")).toBe(ERR_NO_PATH);
    expect(creep.move).not.toHaveBeenCalled(); expect(search).not.toHaveBeenCalled();
  });

  it("已缓存出口执行失败后重新验证，无静态通路时写入短期排除", () => {
    const { creep, search } = traveler();
    expect(moveToTargetRoom(creep, "W0N1", "W1N1|W0N1")).toBe(OK);
    const state = ensureCreepMovementState(creep);
    delete state.movePathState;
    Game.time++;
    search.mockReturnValue([]);
    (PathFinder.search as jest.Mock).mockReturnValue({ path: [], incomplete: true, ops: 1, cost: 0 });
    expect(moveToTargetRoom(creep, "W0N1", "W1N1|W0N1")).toBe(ERR_NO_PATH);
    expect(PathFinder.search).toHaveBeenCalledTimes(3);
    expect(state.travelState!.exitTarget).toBeUndefined();
    expect(state.travelState!.rejectedTransitions?.["W1N1->W0N1"]).toBe(Game.time + 20);
  });

  it("缓存路径到期后旧出口只剩 partial，立即重新选择完整可达的出口", () => {
    const { creep } = traveler();
    let blockOldExit = false;
    const options = { cacheKey: "revalidate-expired-path", costCallback: (_room: string, matrix: CostMatrix) => {
      if (blockOldExit) matrix.set(49, 10, 255);
      return matrix;
    } };
    expect(moveToTargetRoom(creep, "W0N1", "W1N1|W0N1", options)).toBe(OK);
    const state = ensureCreepMovementState(creep);
    expect(state.travelState!.exitTarget).toMatchObject({ x: 49, y: 10 });
    state.movePathState!.expiresAt = Game.time;
    blockOldExit = true; Game.time++;
    expect(moveToTargetRoom(creep, "W0N1", "W1N1|W0N1", options)).toBe(OK);
    expect(state.travelState!.exitTarget?.y).not.toBe(10);
    const strict = (PathFinder.search as jest.Mock).mock.results[1].value as PathFinderPath;
    expect(strict.incomplete).toBe(true); expect(strict.path.length).toBeGreaterThan(0);
    expect(PathFinder.search).toHaveBeenCalledTimes(3);
    expect(state.travelState!.rejectedTransitions).toBeUndefined();
  });

  it("已观察到有主房后失去视野，双人路线选择和实际行军仍一致地改走安全出口", () => {
    const { creep, room, choose } = traveler("powerBankAttacker");
    Game.rooms.W0N1 = { name: "W0N1", controller: { owner: { username: "enemy" }, my: false } } as Room;
    expect(getPowerBankOwnedAvoidRooms()).toContain("W0N1");
    delete Game.rooms.W0N1;
    Game.time += 1;
    const route = "W1N1|W0N1|W3N1";
    Game.map.findRoute = jest.fn((_from, _to, options) => {
      expect(options?.routeCallback?.("W0N1", "W1N1")).toBe(Infinity);
      return [{ exit: TOP, room: "W1N2" }, { exit: TOP, room: "W3N1" }];
    });
    const options = powerBankTransitOptions(creep);
    expect(getNextTravelRoom(room.name, "W3N1", route, options.avoidRooms)).toBe("W1N2");
    room.findExitTo = jest.fn(() => TOP);
    expect(moveToTargetRoom(creep, "W3N1", route, options)).toBe(OK);
    expect(Game.map.describeExits).toHaveBeenCalledWith(room.name);
    expect(room.findExitTo).not.toHaveBeenCalled();
    expect(getPowerBankOwnedAvoidRooms()).toContain("W0N1");
  });

  it("同房路径、缓存命中和出口过房都执行当帧业务下一步安全门", () => {
    const { creep } = traveler();
    const allow = jest.fn(() => false);
    expect(moveToTargetRoom(creep, "W0N1", "W1N1|W0N1", { canMoveStep: allow })).toBe(ERR_BUSY);
    expect(creep.move).not.toHaveBeenCalled();
    allow.mockReturnValue(true);
    Game.time += 1;
    expect(moveToTargetRoom(creep, "W0N1", "W1N1|W0N1", { canMoveStep: allow })).toBe(OK);
    (creep.move as jest.Mock).mockClear();
    allow.mockReturnValue(false); Game.time += 1;
    creep.pos = new MockRoomPosition(49, 10, creep.room.name) as unknown as RoomPosition;
    expect(moveToTargetRoom(creep, "W0N1", "W1N1|W0N1", { canMoveStep: allow })).toBe(ERR_BUSY);
    expect(creep.move).not.toHaveBeenCalled();
    expect(allow).toHaveBeenLastCalledWith(expect.objectContaining({ roomName: "W0N1", x: 0 }));
  });

  it("下一房业务许可等待不销毁通路、不累积几何卡死，恢复后使用原通路", () => {
    const { creep, search } = traveler("powerBankHauler");
    const allow = jest.fn(() => false);
    const options = { canMoveStep: allow };
    expect(moveToTargetRoom(creep, "W0N1", "W1N1|W0N1", options)).toBe(ERR_BUSY);
    const path = getCreepMovementState(creep)!.movePathState;
    for (let frame = 0; frame < 4; frame++) {
      Game.time++;
      expect(moveToTargetRoom(creep, "W0N1", "W1N1|W0N1", options)).toBe(ERR_BUSY);
      expect(getCreepMovementState(creep)!.movePathState).toBe(path);
      expect(getCreepMovementState(creep)!.travelState!.stuckTicks).toBe(0);
    }
    expect(PathFinder.search).toHaveBeenCalledTimes(1);
    allow.mockReturnValue(true); Game.time++;
    expect(moveToTargetRoom(creep, "W0N1", "W1N1|W0N1", options)).toBe(OK);
    expect(creep.move).toHaveBeenCalledWith(RIGHT);
    expect(getCreepMovementState(creep)!.stepPolicyWaitAt).toBeUndefined();
  });

  it("Keeper 感知的回收路线复用原生路由与房内执行器，普通角色保留避让", () => {
    const { creep } = traveler("remoteCarrier");
    const keeperRoom = createRoom("W0N1", []);
    const keeper = { owner: { username: "Source Keeper" }, getActiveBodyparts: () => 1 } as unknown as Creep;
    const originalFind = keeperRoom.find.bind(keeperRoom);
    keeperRoom.find = jest.fn((type: FindConstant) => type === FIND_HOSTILE_CREEPS ? [keeper] : originalFind(type)) as Room["find"];
    Game.map.findRoute = jest.fn((_from, _to, options) => {
      const cost = options?.routeCallback?.("W0N1", creep.room.name);
      return cost === Infinity ? ERR_NO_PATH : [{ exit: RIGHT, room: "W0N1" }, { exit: RIGHT, room: "W0N2" }];
    });
    expect(moveToTargetRoom(creep, "W0N2")).toBe(ERR_NO_PATH);
    expect(moveToTargetRoom(creep, "W0N2", undefined, { allowSourceKeeperRooms: true, canMoveStep: () => true })).toBe(OK);
    expect(creep.move).toHaveBeenCalledWith(RIGHT);
    expect(PathFinder.search).toHaveBeenCalledTimes(1);
    Game.time++; resetRuntimeServices();
    keeper.owner.username = "Invader";
    expect(moveToTargetRoom(creep, "W0N2", undefined, { allowSourceKeeperRooms: true })).toBe(ERR_NO_PATH);
  });

  it("到达目标房后不复用旧房路径，global reset后可重建", () => {
    const { creep } = traveler(); moveToTargetRoom(creep, "W0N1", "W1N1|W0N1");
    clearCreepMovementStateForTest(); clearRoomBaseCostMatrixCacheForTest();
    Game.time += 1;
    expect(moveToTargetRoom(creep, "W0N1", "W1N1|W0N1")).toBe(OK);
    creep.room = createRoom("W0N1");
    expect(moveToTargetRoom(creep, "W0N1")).toBe(OK);
    expect(getCreepMovementState(creep)?.travelState).toBeUndefined();
    expect(getCreepMovementState(creep)?.movePathState).toBeUndefined();
  });
});
