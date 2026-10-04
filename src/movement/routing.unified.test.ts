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
    const search = jest.spyOn(creep.pos, "findPathTo").mockImplementation((_goal, options) => {
      options?.costCallback?.(room.name, new PathFinder.CostMatrix());
      return [{ x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT }, { x: 12, y: 10, dx: 1, dy: 0, direction: RIGHT }];
    });
    return { room, creep, choose, search, units };
  }

  it.each(["remoteMiningCarrier", "remoteCarrier", "remoteWorker", "powerBankAttacker", "powerBankHealer", "scout", "depositHarvester"])("%s 走出口使用房内缓存和交通执行器", (role) => {
    const { creep, search } = traveler(role);
    expect(moveToTargetRoom(creep, "W0N1", "W1N1|W0N1")).toBe(OK);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ x: 49, y: 10 }), expect.objectContaining({ maxRooms: 1, range: 0 }));
    expect(creep.move).toHaveBeenCalledWith(RIGHT);
    expect(PathFinder.search).not.toHaveBeenCalled();
    expect(getCreepMovementState(creep)?.movePathState?.targetX).toBe(49);
    expect(getCreepMovementState(creep)?.travelState?.multiRoomSegment).toBeUndefined();
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
    expect(search).toHaveBeenCalledTimes(1); expect(choose).toHaveBeenCalledTimes(1);
    expect(getCreepMovementState(creep)?.movePathState?.cursor).toBe(0);
  });

  it("载货回到母房卸货时结束旧旅行，不再被旧出口目标影响", () => {
    const { creep, search } = traveler();
    moveToTargetRoom(creep, "W0N1", "W1N1|W0N1");
    Game.time += 1;
    moveToTarget(creep, new MockRoomPosition(20, 20, creep.room.name) as unknown as RoomPosition, 1);
    expect(getCreepMovementState(creep)?.travelState).toBeUndefined();
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ x: 20, y: 20 }), expect.objectContaining({ range: 1 }));
  });

  it("改为撤退时清理旧房内目标和旧私有segment，选择返程出口", () => {
    const { creep, room, search, choose } = traveler();
    moveToTargetRoom(creep, "W0N1", "W1N1|W0N1");
    const state = ensureCreepMovementState(creep);
    state.travelState!.multiRoomSegment = { key: "stale" } as never;
    room.findExitTo = jest.fn(() => TOP);
    choose.mockReturnValue(new MockRoomPosition(10, 0, room.name) as unknown as RoomPosition);
    Game.time += 1;
    moveToTargetRoom(creep, "W1N2", "W1N1|W1N2");
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ y: 0 }), expect.objectContaining({ maxRooms: 1 }));
    expect(state.travelState?.targetRoom).toBe("W1N2");
    expect(state.travelState?.multiRoomSegment).toBeUndefined();
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
    const { creep, choose, search } = traveler(); choose.mockReturnValue(null);
    expect(moveToTargetRoom(creep, "W0N1", "W1N1|W0N1")).toBe(ERR_NO_PATH);
    expect(creep.move).not.toHaveBeenCalled(); expect(search).not.toHaveBeenCalled();
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
    choose.mockReturnValue(new MockRoomPosition(10, 0, room.name) as unknown as RoomPosition);
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
    expect(search).toHaveBeenCalledTimes(1);
    allow.mockReturnValue(true); Game.time++;
    expect(moveToTargetRoom(creep, "W0N1", "W1N1|W0N1", options)).toBe(OK);
    expect(creep.move).toHaveBeenCalledWith(RIGHT);
    expect(getCreepMovementState(creep)!.stepPolicyWaitAt).toBeUndefined();
  });

  it("Keeper 感知的回收路线复用原生路由与房内执行器，普通角色保留避让", () => {
    const { creep } = traveler("remoteCarrier");
    const keeperRoom = createRoom("W0N1", []);
    const keeper = { owner: { username: "Source Keeper" }, getActiveBodyparts: () => 1 } as Creep;
    const originalFind = keeperRoom.find.bind(keeperRoom);
    keeperRoom.find = jest.fn((type: FindConstant) => type === FIND_HOSTILE_CREEPS ? [keeper] : originalFind(type)) as Room["find"];
    Game.map.findRoute = jest.fn((_from, _to, options) => {
      const cost = options?.routeCallback?.("W0N1", creep.room.name);
      return cost === Infinity ? ERR_NO_PATH : [{ exit: RIGHT, room: "W0N1" }, { exit: RIGHT, room: "W0N2" }];
    });
    expect(moveToTargetRoom(creep, "W0N2")).toBe(ERR_NO_PATH);
    expect(moveToTargetRoom(creep, "W0N2", undefined, { allowSourceKeeperRooms: true, canMoveStep: () => true })).toBe(OK);
    expect(creep.move).toHaveBeenCalledWith(RIGHT);
    expect(PathFinder.search).not.toHaveBeenCalled();
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
