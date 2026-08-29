/**
 * 阶段 B 远采路由治理回归测试：
 * - stuck 期完整跨房搜索退避（1/2/4/8/16 指数间隔）；
 * - 位置恢复移动后退避清零；
 * - 输入签名（危险房集合）变化后退避立即失效；
 * - 单次交通阻塞（stuck=1）不触发完整重搜；
 * - 同 tick 相同输入的完整搜索单飞共享，cursor/segment per-creep 独立。
 */
import { clearCreepMovementStateForTest } from "@/movement/creepState";
import { clearMovementAnalyticsForTest, getMovementAnalyticsForTest } from "@/movement/metrics";
import { clearRoutingCachesForTest, moveToTargetRoom } from "@/movement/routing";
import type { MoveToRoomOptions } from "@/movement/types";
import { getSourceContainerPositionsForRoom } from "@/runtime/roomPlannerConstruction";
import { resetRuntimeServices } from "@mock/movement";

jest.mock("@/runtime/roomPlannerConstruction", () => ({
  getSourceContainerPositionsForRoom: jest.fn(() => []),
}));

class TestRoomPosition {
  public constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}

  public getRangeTo(target: RoomPosition | { pos: RoomPosition } | number, y?: number): number {
    if (typeof target === "number") {
      return Math.max(Math.abs(this.x - target), Math.abs(this.y - (y ?? this.y)));
    }
    const pos = "pos" in target ? target.pos : target;
    return Math.max(Math.abs(this.x - pos.x), Math.abs(this.y - pos.y));
  }

  public getDirectionTo(target: RoomPosition | { x: number; y: number }): DirectionConstant {
    const dx = Math.sign(target.x - this.x);
    const dy = Math.sign(target.y - this.y);
    if (dx === 0 && dy === -1) return TOP;
    if (dx === 1 && dy === -1) return TOP_RIGHT;
    if (dx === 1 && dy === 0) return RIGHT;
    if (dx === 1 && dy === 1) return BOTTOM_RIGHT;
    if (dx === 0 && dy === 1) return BOTTOM;
    if (dx === -1 && dy === 1) return BOTTOM_LEFT;
    if (dx === -1 && dy === 0) return LEFT;
    return TOP_LEFT;
  }

  public isEqualTo(target: RoomPosition): boolean {
    return this.x === target.x && this.y === target.y && this.roomName === target.roomName;
  }
}

class TestCostMatrix {
  private values = new Uint8Array(2500);

  public set(x: number, y: number, value: number): void {
    this.values[y * 50 + x] = value;
  }

  public get(x: number, y: number): number {
    return this.values[y * 50 + x];
  }

  public clone(): TestCostMatrix {
    const clone = new TestCostMatrix();
    clone.values.set(this.values);
    return clone;
  }
}

type PositionWithFallbackSpies = RoomPosition & {
  findClosestByPath: jest.Mock;
  findClosestByRange: jest.Mock;
  findPathTo: jest.Mock;
};

const DEFAULT_TARGET = "W1N3";
const DEFAULT_ROUTE = "W1N1|W1N2|W1N3";
const DEFAULT_OPTIONS: MoveToRoomOptions = {
  plainCost: 2,
  swampCost: 10,
  maxRooms: 16,
  reusePath: 10,
  ignoreCreeps: true,
  travelRange: 1,
};

function createPosition(x: number, y: number, roomName: string): PositionWithFallbackSpies {
  const position = new TestRoomPosition(x, y, roomName);
  return Object.assign(position, {
    findClosestByPath: jest.fn(() => new TestRoomPosition(49, y, roomName) as unknown as RoomPosition),
    findClosestByRange: jest.fn(() => new TestRoomPosition(49, y, roomName) as unknown as RoomPosition),
    findPathTo: jest.fn(() => [{ x: Math.min(x + 1, 49), y, dx: 1, dy: 0, direction: RIGHT }]),
  }) as unknown as PositionWithFallbackSpies;
}

function createRoom(roomName: string): Room {
  return {
    name: roomName,
    findExitTo: jest.fn(() => RIGHT),
    find: jest.fn((findConstant: FindConstant | ExitConstant) => {
      if (findConstant === RIGHT || findConstant === FIND_EXIT) {
        return [new TestRoomPosition(49, 25, roomName)];
      }
      if (findConstant === FIND_MY_CREEPS) {
        return Object.values(Game.creeps).filter((creep) => creep.room.name === roomName);
      }
      return [];
    }),
    controller: undefined,
    energyAvailable: 300,
    energyCapacityAvailable: 300,
  } as unknown as Room;
}

function createTravelCreep(room: Room, x = 10, y = 25, name = "backoff-carrier"): Creep {
  const creep = {
    name,
    room,
    pos: createPosition(x, y, room.name),
    fatigue: 0,
    memory: { role: "remoteMiningCarrier" },
    move: jest.fn(() => OK),
    moveTo: jest.fn(() => OK),
  } as unknown as Creep;
  Game.creeps[name] = creep;
  return creep;
}

function relocate(creep: Creep, room: Room, x: number, y = 25): void {
  Object.assign(creep, {
    room,
    pos: createPosition(x, y, room.name),
  });
}

function currentRoomPath(origin: RoomPosition, length = 50): RoomPosition[] {
  const positions: RoomPosition[] = [];
  for (let offset = 1; offset <= length && origin.x + offset <= 49; offset += 1) {
    positions.push(new TestRoomPosition(origin.x + offset, origin.y, origin.roomName) as unknown as RoomPosition);
  }
  if (positions[positions.length - 1]?.x === 49) {
    const transitionRoom = origin.roomName === "W1N1" ? "W1N2" : "W1N3";
    positions.push(new TestRoomPosition(0, origin.y, transitionRoom) as unknown as RoomPosition);
  }
  return positions;
}

function useSuccessfulCurrentRoomSearch(): jest.Mock {
  const search = PathFinder.search as jest.Mock;
  search.mockImplementation((origin: RoomPosition) => ({
    path: currentRoomPath(origin),
    incomplete: false,
    ops: 20,
    cost: 20,
  }));
  return search;
}

function travel(
  creep: Creep,
  targetRoom = DEFAULT_TARGET,
  route = DEFAULT_ROUTE,
  options: MoveToRoomOptions = DEFAULT_OPTIONS,
): ScreepsReturnCode {
  return moveToTargetRoom(creep, targetRoom, route, options);
}

describe("moveToTargetRoom stuck backoff and shared search", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearCreepMovementStateForTest();
    clearMovementAnalyticsForTest();
    clearRoutingCachesForTest();
    Game.time = 100;
    Game.rooms = {};
    Game.creeps = {};
    Game.powerCreeps = {};
    Game.spawns = {};
    Memory.cfg = { movementMetrics: { mode: "rooms" } };
    Memory.data = undefined;
    (getSourceContainerPositionsForRoom as jest.Mock).mockReturnValue([]);

    Object.assign(global, {
      RoomPosition: TestRoomPosition,
      PathFinder: {
        search: jest.fn(() => ({ path: [], incomplete: true, ops: 0, cost: 0 })),
        CostMatrix: TestCostMatrix,
      },
      Room: {
        serializePath: jest.fn((path: Array<{ direction: DirectionConstant }>) => path.map((step) => step.direction).join("")),
      },
    });

    Game.map = {
      getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) })),
      getRoomStatus: jest.fn(() => ({ status: "normal" })),
      findRoute: jest.fn(() => [{ exit: RIGHT, room: "W1N2" }]),
      describeExits: jest.fn((roomName: string) => {
        if (roomName === "W1N1") return { [RIGHT]: "W1N2" };
        if (roomName === "W1N2") return { [LEFT]: "W1N1", [RIGHT]: "W1N3" };
        if (roomName === "W1N3") return { [LEFT]: "W1N2" };
        return {};
      }),
      getRoomLinearDistance: jest.fn(() => 1),
    } as unknown as GameMap;
  });

  it("single congestion tick (stuck=1) keeps the segment instead of a full multi-room search", () => {
    const room = createRoom("W1N1");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room, 10, 25, "congested-carrier");
    const search = useSuccessfulCurrentRoomSearch();

    expect(travel(creep)).toBe(OK);
    expect(search).toHaveBeenCalledTimes(1);

    // 交通阻塞一 tick（位置未变）：segment 仍可复用，不触发完整跨房重搜。
    Game.time += 1;
    expect(travel(creep)).toBe(OK);
    expect(search).toHaveBeenCalledTimes(1);
    expect(getMovementAnalyticsForTest().totals.multiRoomSegmentHits).toBe(1);
    expect(getMovementAnalyticsForTest().totals.multiRoomSearches).toBe(1);
  });

  it("sustained congestion retries the full search with exponential backoff skips", () => {
    const room = createRoom("W1N1");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room, 10, 25, "stuck-carrier");
    const search = useSuccessfulCurrentRoomSearch();

    expect(travel(creep)).toBe(OK);
    expect(search).toHaveBeenCalledTimes(1);

    // stuck=1：segment 复用。
    Game.time += 1;
    expect(travel(creep)).toBe(OK);
    expect(search).toHaveBeenCalledTimes(1);

    // stuck=2：段缓存被禁用，完整搜索执行（第 2 次），退避 level=1（跳过 1 tick）。
    Game.time += 1;
    expect(travel(creep)).toBe(OK);
    expect(search).toHaveBeenCalledTimes(2);

    // 退避窗口内：跳过完整搜索，回落出口方向 fallback。
    Game.time += 1;
    expect(travel(creep)).toBe(OK);
    expect(search).toHaveBeenCalledTimes(2);
    expect(getMovementAnalyticsForTest().totals.fullSearchBackoffSkips).toBe(1);

    // 退避到期：恢复完整搜索，随后进入更长的第二档退避（跳过 2 tick）。
    Game.time += 1;
    expect(travel(creep)).toBe(OK);
    expect(search).toHaveBeenCalledTimes(3);
    Game.time += 1;
    expect(travel(creep)).toBe(OK);
    expect(search).toHaveBeenCalledTimes(3);
    expect(getMovementAnalyticsForTest().totals.fullSearchBackoffSkips).toBe(2);
    Game.time += 1;
    expect(travel(creep)).toBe(OK);
    expect(search).toHaveBeenCalledTimes(3);
    expect(getMovementAnalyticsForTest().totals.fullSearchBackoffSkips).toBe(3);
    // 第二档退避到期后恢复搜索。
    Game.time += 1;
    expect(travel(creep)).toBe(OK);
    expect(search).toHaveBeenCalledTimes(4);
  });

  it("recovering movement clears the backoff so the next congestion searches immediately", () => {
    const room = createRoom("W1N1");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room, 10, 25, "recovered-carrier");
    const search = useSuccessfulCurrentRoomSearch();

    expect(travel(creep)).toBe(OK);
    Game.time += 1;
    expect(travel(creep)).toBe(OK);
    Game.time += 1;
    expect(travel(creep)).toBe(OK);
    expect(search).toHaveBeenCalledTimes(2);

    // 位置恢复移动：stuck 与退避一并清零（本 tick 处于第一档退避窗口内，
    // 但仍立即执行完整搜索并重建 segment）。
    Game.time += 1;
    relocate(creep, room, 11, 25);
    expect(travel(creep)).toBe(OK);
    expect(search).toHaveBeenCalledTimes(3);
    // 恢复后的下一 tick：segment 命中（而非退避跳过或重搜）。
    Game.time += 1;
    expect(travel(creep)).toBe(OK);
    expect(search).toHaveBeenCalledTimes(3);
    expect(getMovementAnalyticsForTest().totals.multiRoomSegmentHits).toBeGreaterThanOrEqual(1);
    expect(getMovementAnalyticsForTest().totals.fullSearchBackoffSkips).toBe(0);
  });

  it("a changed dangerous-room signature cancels the backoff and retries immediately", () => {
    const room = createRoom("W1N1");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room, 10, 25, "danger-carrier");
    const search = useSuccessfulCurrentRoomSearch();

    expect(travel(creep)).toBe(OK);
    Game.time += 1;
    expect(travel(creep)).toBe(OK);
    Game.time += 1;
    expect(travel(creep)).toBe(OK);
    expect(search).toHaveBeenCalledTimes(2);

    // 退避窗口内引入新的危险房：签名变化必须允许立即完整重搜。
    Memory.data = {
      colonization: {
        [DEFAULT_TARGET]: { dangerousRooms: ["W1N9"] },
      },
    } as unknown as Memory["data"];
    Game.time += 1;
    expect(travel(creep)).toBe(OK);
    expect(search).toHaveBeenCalledTimes(3);
  });

  it("shares one full search per tick across same-route creeps with independent cursors", () => {
    const room = createRoom("W1N1");
    Game.rooms[room.name] = room;
    const first = createTravelCreep(room, 10, 25, "shared-first");
    const second = createTravelCreep(room, 10, 26, "shared-second");
    const search = useSuccessfulCurrentRoomSearch();

    expect(travel(first)).toBe(OK);
    expect(travel(second)).toBe(OK);
    // 同 tick 相同输入只执行一次完整搜索；第二个 creep 走共享对齐。
    expect(search).toHaveBeenCalledTimes(1);
    expect(getMovementAnalyticsForTest().totals.sharedSearchHits).toBe(1);

    // 下一 tick 共享缓存自然过期；两个 creep 各自的 segment（独立 cursor）接管。
    Game.time += 1;
    relocate(first, room, 11, 25);
    relocate(second, room, 11, 26);
    expect(travel(first)).toBe(OK);
    expect(travel(second)).toBe(OK);
    expect(search).toHaveBeenCalledTimes(1);
    expect(getMovementAnalyticsForTest().totals.multiRoomSegmentHits).toBe(2);
  });
});
