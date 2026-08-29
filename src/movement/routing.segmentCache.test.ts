import {
  clearCreepMovementState,
  clearCreepMovementStateForTest,
  ensureCreepMovementState,
  getCreepMovementState,
  pruneDeadCreepMovementState,
} from "@/movement/creepState";
import { clearMovementAnalyticsForTest, getMovementAnalyticsForTest } from "@/movement/metrics";
import { clearRoutingCachesForTest, getColonizationTravelPathKey, moveToTargetRoom } from "@/movement/routing";
import type { MoveToRoomOptions, StoredRoomPosition } from "@/movement/types";
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
    findPathTo: jest.fn(() => [
      { x: Math.min(x + 1, 49), y, dx: 1, dy: 0, direction: RIGHT },
    ]),
  }) as unknown as PositionWithFallbackSpies;
}

function createRoom(roomName: string, nextRoom: string): Room {
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

function createTravelCreep(room: Room, x = 10, y = 25, name = "segment-carrier"): Creep {
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

describe("moveToTargetRoom multi-room segment cache", () => {
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
      findRoute: jest.fn(() => [{ exit: RIGHT, room: "W1N2" }]),
      describeExits: jest.fn((roomName: string) => {
        if (roomName === "W1N1") return { [RIGHT]: "W1N2" };
        if (roomName === "W1N2") return { [LEFT]: "W1N1", [RIGHT]: "W1N3" };
        if (roomName === "W1N3") return { [LEFT]: "W1N2" };
        return null;
      }),
      getRoomLinearDistance: jest.fn(() => 1),
      getRoomStatus: jest.fn(() => ({ status: "normal" })),
    } as unknown as GameMap;
  });

  it("reduces ten reusable travel ticks to one PathFinder.search", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room);
    const search = useSuccessfulCurrentRoomSearch();

    for (let tick = 0; tick < 10; tick += 1) {
      if (tick > 0) {
        Game.time += 1;
        relocate(creep, room, 10 + tick);
      }
      expect(travel(creep)).toBe(OK);
    }

    expect(search).toHaveBeenCalledTimes(1);
    expect(creep.move).toHaveBeenCalledTimes(10);
    expect(getMovementAnalyticsForTest().totals).toMatchObject({
      multiRoomSearches: 1,
      multiRoomSegmentHits: 9,
      multiRoomSegmentInvalidations: 0,
    });
  });

  it("renews the idle lease across a long segment while fatigue returns ERR_TIRED", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room, 5);
    const search = useSuccessfulCurrentRoomSearch();
    let x = creep.pos.x;

    expect(travel(creep)).toBe(OK);
    for (let tick = 1; tick <= 40; tick += 1) {
      Game.time += 1;
      const fatigued = tick % 4 === 0;
      creep.fatigue = fatigued ? 1 : 0;
      if (!fatigued) {
        x += 1;
        relocate(creep, room, x);
      }
      (creep.move as jest.Mock).mockReturnValueOnce(fatigued ? ERR_TIRED : OK);
      expect(travel(creep)).toBe(fatigued ? ERR_TIRED : OK);
    }

    const segment = getCreepMovementState(creep)?.travelState?.multiRoomSegment;
    expect(search).toHaveBeenCalledTimes(1);
    expect(segment?.expiresAt).toBeGreaterThan(Game.time);
    expect(segment?.expiresAt).toBeLessThanOrEqual(segment!.hardExpiresAt);
    expect(getMovementAnalyticsForTest().totals.multiRoomSegmentHits).toBe(40);
  });

  it("stores only the current-room prefix and one adjacent-room transition step", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room, 47);
    const returnedPath = [
      new TestRoomPosition(48, 25, "W1N1"),
      new TestRoomPosition(49, 25, "W1N1"),
      new TestRoomPosition(0, 25, "W1N2"),
      new TestRoomPosition(1, 25, "W1N2"),
      new TestRoomPosition(2, 25, "W1N2"),
      new TestRoomPosition(0, 25, "W1N3"),
    ] as unknown as RoomPosition[];
    (PathFinder.search as jest.Mock).mockReturnValue({ path: returnedPath, incomplete: false, ops: 20, cost: 20 });

    expect(travel(creep)).toBe(OK);

    expect(getCreepMovementState(creep)?.travelState?.multiRoomSegment).toMatchObject({
      currentRoom: "W1N1",
      transitionIndex: 2,
      positions: [
        { x: 48, y: 25, roomName: "W1N1" },
        { x: 49, y: 25, roomName: "W1N1" },
        { x: 0, y: 25, roomName: "W1N2" },
      ] satisfies StoredRoomPosition[],
      generatedAt: Game.time,
    });
  });

  it.each([
    ["plainCost", { plainCost: 3 }],
    ["swampCost", { swampCost: 11 }],
    ["travelRange", { travelRange: 3 as const }],
    ["maxRooms", { maxRooms: 12 }],
    ["reusePath", { reusePath: 4 }],
    ["ignoreCreeps", { ignoreCreeps: false }],
  ])("invalidates and searches immediately when %s changes", (_field, changedOptions) => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room);
    const search = useSuccessfulCurrentRoomSearch();

    expect(travel(creep)).toBe(OK);
    Game.time += 1;
    relocate(creep, room, 11);
    expect(travel(creep, DEFAULT_TARGET, DEFAULT_ROUTE, { ...DEFAULT_OPTIONS, ...changedOptions })).toBe(OK);

    expect(search).toHaveBeenCalledTimes(2);
    expect(getMovementAnalyticsForTest().totals.multiRoomSegmentInvalidations).toBe(1);
    if ("ignoreCreeps" in changedOptions && changedOptions.ignoreCreeps === false) {
      expect(getCreepMovementState(creep)?.travelState?.multiRoomSegment).toBeUndefined();
    }
  });

  it("invalidates when the target room changes", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room);
    const search = useSuccessfulCurrentRoomSearch();

    expect(travel(creep)).toBe(OK);
    Game.time += 1;
    relocate(creep, room, 11);
    expect(travel(creep, "W1N4", DEFAULT_ROUTE)).toBe(OK);

    expect(search).toHaveBeenCalledTimes(2);
    expect(getMovementAnalyticsForTest().totals.multiRoomSegmentInvalidations).toBe(1);
  });

  it("invalidates when ordered route identity changes even if the selected next room does not", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room);
    const search = useSuccessfulCurrentRoomSearch();

    expect(travel(creep)).toBe(OK);
    Game.time += 1;
    relocate(creep, room, 11);
    expect(travel(creep, DEFAULT_TARGET, "W1N1|W1N2|W9N9|W1N3")).toBe(OK);

    expect(search).toHaveBeenCalledTimes(2);
    expect(getMovementAnalyticsForTest().totals.multiRoomSegmentInvalidations).toBe(1);
  });

  it("invalidates when the selected next room changes under the same route", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room);
    const search = useSuccessfulCurrentRoomSearch();
    const route = "W1N1|W1N2|W2N1|W1N3";

    expect(travel(creep, DEFAULT_TARGET, route)).toBe(OK);
    Game.time += 1;
    relocate(creep, room, 11);
    (Game.map.describeExits as jest.Mock).mockImplementation((roomName: string) => (
      roomName === "W1N1" ? { [RIGHT]: "W2N1" } : null
    ));
    (Game.map.findRoute as jest.Mock).mockReturnValue([{ exit: RIGHT, room: "W2N1" }]);
    expect(travel(creep, DEFAULT_TARGET, route)).toBe(OK);

    expect(search).toHaveBeenCalledTimes(2);
    expect(getMovementAnalyticsForTest().totals.multiRoomSegmentInvalidations).toBe(1);
  });

  it("invalidates when the dangerous-room membership changes", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room);
    const search = useSuccessfulCurrentRoomSearch();

    expect(travel(creep, DEFAULT_TARGET, DEFAULT_ROUTE, { ...DEFAULT_OPTIONS, avoidRooms: ["W8N8"] })).toBe(OK);
    Game.time += 1;
    relocate(creep, room, 11);
    expect(travel(creep, DEFAULT_TARGET, DEFAULT_ROUTE, { ...DEFAULT_OPTIONS, avoidRooms: ["W9N9"] })).toBe(OK);

    expect(search).toHaveBeenCalledTimes(2);
    expect(getMovementAnalyticsForTest().totals.multiRoomSegmentInvalidations).toBe(1);
  });

  it("treats dangerous rooms as a deduplicated order-independent set", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room);
    const search = useSuccessfulCurrentRoomSearch();

    expect(travel(creep, DEFAULT_TARGET, DEFAULT_ROUTE, {
      ...DEFAULT_OPTIONS,
      avoidRooms: ["W8N8", "W9N9"],
    })).toBe(OK);
    Game.time += 1;
    relocate(creep, room, 11);
    expect(travel(creep, DEFAULT_TARGET, DEFAULT_ROUTE, {
      ...DEFAULT_OPTIONS,
      avoidRooms: ["W9N9", "W8N8", "W9N9"],
    })).toBe(OK);

    expect(search).toHaveBeenCalledTimes(1);
    expect(getMovementAnalyticsForTest().totals).toMatchObject({
      multiRoomSegmentHits: 1,
      multiRoomSegmentInvalidations: 0,
    });
  });

  it("invalidates when routing changes from fixed to dynamic mode", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room);
    const search = useSuccessfulCurrentRoomSearch();

    expect(travel(creep)).toBe(OK);
    Game.time += 1;
    relocate(creep, room, 11);
    expect(travel(creep, DEFAULT_TARGET, "")).toBe(OK);

    expect(search).toHaveBeenCalledTimes(2);
    expect(getMovementAnalyticsForTest().totals.multiRoomSegmentInvalidations).toBe(1);
  });

  it.each([
    ["room status", false],
    ["visible hostile ownership", true],
  ])("rechecks live next-room safety before a segment hit when %s changes", (_label, hostileVisible) => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room);
    const search = useSuccessfulCurrentRoomSearch();

    expect(travel(creep)).toBe(OK);
    Game.time += 1;
    relocate(creep, room, 11);
    if (hostileVisible) {
      const hostileRoom = createRoom("W1N2", "W1N3");
      hostileRoom.controller = {
        my: false,
        owner: { username: "enemy" },
      } as StructureController;
      Game.rooms.W1N2 = hostileRoom;
    } else {
      (Game.map.getRoomStatus as jest.Mock).mockImplementation((roomName: string) => ({
        status: roomName === "W1N2" ? "closed" : "normal",
      }));
    }

    expect(travel(creep)).toBe(OK);

    const searchOptions = search.mock.calls[1][2] as { roomCallback: (roomName: string) => boolean | CostMatrix };
    expect(searchOptions.roomCallback("W1N2")).toBe(false);
    expect(search).toHaveBeenCalledTimes(2);
    expect(getCreepMovementState(creep)?.travelState?.multiRoomSegment).toBeUndefined();
    expect(getMovementAnalyticsForTest().totals.multiRoomSegmentInvalidations).toBe(1);
  });

  it("memoizes live next-room safety once per room and tick across creeps", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const first = createTravelCreep(room, 10, 25, "first-carrier");
    const second = createTravelCreep(room, 10, 26, "second-carrier");
    const search = useSuccessfulCurrentRoomSearch();

    expect(travel(first)).toBe(OK);
    expect(travel(second)).toBe(OK);
    Game.time += 1;
    relocate(first, room, 11, 25);
    relocate(second, room, 11, 26);
    (Game.map.getRoomStatus as jest.Mock).mockClear();

    expect(travel(first)).toBe(OK);
    expect(travel(second)).toBe(OK);

    // 同 tick 单飞：第二个 creep 复用第一个的完整搜索（sharedSearchHits）并
    // 建立自己的 segment，因此本 tick 只有 1 次搜索；下一 tick 两者均走
    // segment 命中，搜索总数保持 1。
    expect(search).toHaveBeenCalledTimes(1);
    expect(Game.map.getRoomStatus).toHaveBeenCalledTimes(1);
    expect(Game.map.getRoomStatus).toHaveBeenCalledWith("W1N2");
    expect(getMovementAnalyticsForTest().totals.sharedSearchHits).toBe(1);
    expect(getMovementAnalyticsForTest().totals.multiRoomSegmentHits).toBe(2);
  });

  it("invalidates an unsafe segment at the selected exit while preserving the legacy direct-exit intent", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room, 47);
    const search = useSuccessfulCurrentRoomSearch();

    expect(travel(creep)).toBe(OK);
    Game.time += 1;
    relocate(creep, room, 49);
    (Game.map.getRoomStatus as jest.Mock).mockImplementation((roomName: string) => ({
      status: roomName === "W1N2" ? "closed" : "normal",
    }));

    expect(travel(creep)).toBe(OK);

    expect(creep.move).toHaveBeenLastCalledWith(RIGHT);
    expect(search).toHaveBeenCalledTimes(1);
    expect(getMovementAnalyticsForTest().totals).toMatchObject({
      multiRoomSegmentHits: 0,
      multiRoomSegmentInvalidations: 1,
    });
  });

  it.each([
    ["reusePath=0", { ...DEFAULT_OPTIONS, reusePath: 0 }],
    ["ignoreCreeps=false", { ...DEFAULT_OPTIONS, ignoreCreeps: false }],
  ])("never caches a dynamic-occupancy search for %s", (_label, options) => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room);
    const search = useSuccessfulCurrentRoomSearch();

    expect(travel(creep, DEFAULT_TARGET, DEFAULT_ROUTE, options)).toBe(OK);
    expect(getCreepMovementState(creep)?.travelState?.multiRoomSegment).toBeUndefined();
    Game.time += 1;
    relocate(creep, room, 11);
    expect(travel(creep, DEFAULT_TARGET, DEFAULT_ROUTE, options)).toBe(OK);

    expect(search).toHaveBeenCalledTimes(2);
    expect(getMovementAnalyticsForTest().totals).toMatchObject({
      multiRoomSearches: 2,
      multiRoomSegmentHits: 0,
      multiRoomSegmentInvalidations: 0,
    });
  });

  it.each([
    ["non-finite", Number.POSITIVE_INFINITY, 20],
    ["negative", -10, 20],
    ["oversized", 10_000, 50],
  ])("normalizes %s reusePath into finite bounded segment leases", (_label, reusePath, expectedTtl) => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room);
    useSuccessfulCurrentRoomSearch();

    expect(travel(creep, DEFAULT_TARGET, DEFAULT_ROUTE, { ...DEFAULT_OPTIONS, reusePath })).toBe(OK);

    const segment = getCreepMovementState(creep)?.travelState?.multiRoomSegment;
    if (reusePath < 0) {
      expect(segment).toBeUndefined();
      return;
    }
    expect(segment).toMatchObject({
      reuseTtl: expectedTtl,
      expiresAt: Game.time + expectedTtl,
      hardExpiresAt: Game.time + 150,
    });
    expect(Number.isFinite(segment!.expiresAt)).toBe(true);
    expect(Number.isFinite(segment!.hardExpiresAt)).toBe(true);
  });

  it("rejects a segment at its exact TTL boundary and performs a fresh search", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room);
    const search = useSuccessfulCurrentRoomSearch();

    expect(travel(creep)).toBe(OK);
    const firstSegment = getCreepMovementState(creep)?.travelState?.multiRoomSegment;
    expect(firstSegment).toBeDefined();
    Game.time = firstSegment!.expiresAt;
    relocate(creep, room, 11);
    expect(travel(creep)).toBe(OK);

    expect(search).toHaveBeenCalledTimes(2);
    expect(getCreepMovementState(creep)?.travelState?.multiRoomSegment?.generatedAt).toBe(Game.time);
    expect(getMovementAnalyticsForTest().totals.multiRoomSegmentInvalidations).toBe(1);
  });

  it("rejects a continuously leased segment at the exact hard-expiry boundary", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room);
    const search = useSuccessfulCurrentRoomSearch();

    expect(travel(creep)).toBe(OK);
    const firstSegment = getCreepMovementState(creep)?.travelState?.multiRoomSegment;
    firstSegment!.expiresAt = firstSegment!.hardExpiresAt + 1;
    Game.time = firstSegment!.hardExpiresAt;
    relocate(creep, room, 11);

    expect(travel(creep)).toBe(OK);

    expect(search).toHaveBeenCalledTimes(2);
    expect(getCreepMovementState(creep)?.travelState?.multiRoomSegment?.generatedAt).toBe(Game.time);
    expect(getMovementAnalyticsForTest().totals.multiRoomSegmentInvalidations).toBe(1);
  });

  it("drops the segment at the existing stuck threshold and does not cache the dynamic recovery", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room);
    const blocker = createTravelCreep(room, 20, 25, "blocker");
    const search = useSuccessfulCurrentRoomSearch();

    expect(travel(creep)).toBe(OK);
    Game.time += 1;
    expect(travel(creep)).toBe(OK);
    Game.time += 1;
    expect(travel(creep)).toBe(OK);

    expect(search).toHaveBeenCalledTimes(2);
    expect(getCreepMovementState(creep)?.travelState?.multiRoomSegment).toBeUndefined();
    const recoveryOptions = search.mock.calls[1][2] as { roomCallback: (roomName: string) => CostMatrix };
    expect(recoveryOptions.roomCallback(room.name).get(blocker.pos.x, blocker.pos.y)).toBe(0xfe);
    expect(getMovementAnalyticsForTest().totals).toMatchObject({
      multiRoomSearches: 2,
      multiRoomSegmentHits: 1,
      multiRoomSegmentInvalidations: 1,
    });
  });

  it("invalidates and searches when traffic leaves the creep more than one tile from every segment step", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room);
    const search = useSuccessfulCurrentRoomSearch();

    expect(travel(creep)).toBe(OK);
    Game.time += 1;
    relocate(creep, room, 35, 35);
    expect(travel(creep)).toBe(OK);

    expect(search).toHaveBeenCalledTimes(2);
    expect(getMovementAnalyticsForTest().totals.multiRoomSegmentInvalidations).toBe(1);
  });

  it("reattaches only ahead of the cursor on a hairpin instead of walking backward", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room);
    const path = [
      [11, 25], [12, 25], [13, 25], [13, 26], [12, 26], [11, 26], [10, 26], [9, 26],
      [8, 26], [7, 26], [6, 26], [5, 26], [4, 26], [3, 26], [2, 26], [1, 26],
      [1, 25], [1, 24],
      ...Array.from({ length: 48 }, (_, index) => [index + 2, 24]),
    ].map(([x, y]) => new TestRoomPosition(x, y, "W1N1"));
    path.push(new TestRoomPosition(0, 24, "W1N2"));
    (PathFinder.search as jest.Mock).mockReturnValue({ path, incomplete: false, ops: 40, cost: 40 });

    expect(travel(creep)).toBe(OK);
    Game.time += 1;
    relocate(creep, room, 13, 26);
    expect(travel(creep)).toBe(OK);
    Game.time += 1;
    relocate(creep, room, 13, 25);
    expect(travel(creep)).toBe(OK);
    expect(creep.move).toHaveBeenLastCalledWith(BOTTOM_LEFT);
    Game.time += 1;
    relocate(creep, room, 12, 26);
    expect(travel(creep)).toBe(OK);

    expect(creep.move).toHaveBeenLastCalledWith(LEFT);
    expect(PathFinder.search).toHaveBeenCalledTimes(1);
    expect(getCreepMovementState(creep)?.travelState?.multiRoomSegment?.cursor).toBe(4);
  });

  it("does not retain an overlong current-room segment", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room, 1, 1);
    const path: RoomPosition[] = [];
    let x = 1;
    let y = 1;
    let direction = 1;
    while (path.length < 101) {
      if ((direction > 0 && x < 48) || (direction < 0 && x > 1)) {
        x += direction;
      } else {
        y += 1;
        direction *= -1;
      }
      path.push(new TestRoomPosition(x, y, "W1N1") as unknown as RoomPosition);
    }
    (PathFinder.search as jest.Mock).mockReturnValue({ path, incomplete: false, ops: 100, cost: 100 });

    expect(travel(creep)).toBe(OK);

    expect(getCreepMovementState(creep)?.travelState?.multiRoomSegment).toBeUndefined();
  });

  it("uses the transition step, then rebuilds the segment after entering the next room", () => {
    const firstRoom = createRoom("W1N1", "W1N2");
    const nextRoom = createRoom("W1N2", "W1N3");
    Game.rooms[firstRoom.name] = firstRoom;
    Game.rooms[nextRoom.name] = nextRoom;
    const creep = createTravelCreep(firstRoom, 47);
    const search = PathFinder.search as jest.Mock;
    search.mockImplementation((origin: RoomPosition) => ({
      path: origin.roomName === "W1N1"
        ? [
          new TestRoomPosition(48, 25, "W1N1"),
          new TestRoomPosition(49, 25, "W1N1"),
          new TestRoomPosition(0, 25, "W1N2"),
          new TestRoomPosition(1, 25, "W1N2"),
        ]
        : currentRoomPath(origin),
      incomplete: false,
      ops: 20,
      cost: 20,
    }));

    expect(travel(creep)).toBe(OK);
    Game.time += 1;
    relocate(creep, firstRoom, 48);
    expect(travel(creep)).toBe(OK);
    Game.time += 1;
    relocate(creep, firstRoom, 49);
    expect(travel(creep)).toBe(OK);
    expect(search).toHaveBeenCalledTimes(1);
    expect(getMovementAnalyticsForTest().totals.multiRoomSegmentHits).toBe(2);

    Game.time += 1;
    relocate(creep, nextRoom, 0);
    expect(travel(creep)).toBe(OK);
    expect(search).toHaveBeenCalledTimes(1);
    expect(getCreepMovementState(creep)?.travelState?.multiRoomSegment).toBeUndefined();

    Game.time += 1;
    relocate(creep, nextRoom, 1);
    expect(travel(creep)).toBe(OK);

    expect(search).toHaveBeenCalledTimes(2);
    expect(getCreepMovementState(creep)?.travelState?.multiRoomSegment?.currentRoom).toBe("W1N2");
    const analytics = getMovementAnalyticsForTest();
    expect(analytics.totals.multiRoomSegmentInvalidations).toBe(1);
    expect(analytics.rooms.W1N1).toMatchObject({
      multiRoomSearches: 1,
      multiRoomSegmentHits: 2,
      multiRoomSegmentInvalidations: 0,
    });
    expect(analytics.rooms.W1N2).toMatchObject({
      multiRoomSearches: 1,
      multiRoomSegmentHits: 0,
      multiRoomSegmentInvalidations: 1,
    });
  });

  it("keeps the selected direct-exit direction when a corner segment points across another edge", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    (Game.map.describeExits as jest.Mock).mockImplementation((roomName: string) => (
      roomName === "W1N1" ? { [TOP]: "W0N1", [RIGHT]: "W1N2" } : null
    ));
    const creep = createTravelCreep(room, 47, 1);
    (PathFinder.search as jest.Mock).mockReturnValue({
      path: [
        new TestRoomPosition(48, 1, "W1N1"),
        new TestRoomPosition(49, 0, "W1N1"),
        new TestRoomPosition(49, 49, "W0N1"),
      ],
      incomplete: false,
      ops: 20,
      cost: 20,
    });

    expect(travel(creep)).toBe(OK);
    Game.time += 1;
    relocate(creep, room, 49, 0);
    expect(travel(creep)).toBe(OK);

    expect(creep.move).toHaveBeenLastCalledWith(RIGHT);
    expect(PathFinder.search).toHaveBeenCalledTimes(1);
    expect(getMovementAnalyticsForTest().totals).toMatchObject({
      multiRoomSegmentHits: 0,
      multiRoomSegmentInvalidations: 0,
    });
    expect(getCreepMovementState(creep)?.travelState?.multiRoomSegment).toBeUndefined();
  });

  it("preserves a legal diagonal step while crossing the selected room edge", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room, 47);
    (PathFinder.search as jest.Mock).mockReturnValue({
      path: [
        new TestRoomPosition(48, 25, "W1N1"),
        new TestRoomPosition(49, 25, "W1N1"),
        new TestRoomPosition(0, 24, "W1N2"),
      ],
      incomplete: false,
      ops: 20,
      cost: 20,
    });

    expect(travel(creep)).toBe(OK);
    Game.time += 1;
    relocate(creep, room, 49);
    expect(travel(creep)).toBe(OK);

    expect(creep.move).toHaveBeenLastCalledWith(TOP_RIGHT);
    expect(getMovementAnalyticsForTest().totals.multiRoomSegmentHits).toBe(1);
  });

  it.each([
    ["RIGHT", RIGHT, [47, 25], [48, 25], [49, 25], [0, 25]],
    ["LEFT", LEFT, [2, 25], [1, 25], [0, 25], [49, 25]],
    ["TOP", TOP, [25, 2], [25, 1], [25, 0], [25, 49]],
    ["BOTTOM", BOTTOM, [25, 47], [25, 48], [25, 49], [25, 0]],
  ])("follows a validated %s cardinal transition", (_label, exitDirection, origin, first, edge, next) => {
    const room = createRoom("W1N1", "W1N2");
    room.findExitTo = jest.fn(() => exitDirection as ExitConstant);
    Game.rooms[room.name] = room;
    (Game.map.describeExits as jest.Mock).mockImplementation((roomName: string) => (
      roomName === "W1N1" ? { [exitDirection]: "W1N2" } : null
    ));
    const creep = createTravelCreep(room, origin[0], origin[1]);
    (PathFinder.search as jest.Mock).mockReturnValue({
      path: [
        new TestRoomPosition(first[0], first[1], "W1N1"),
        new TestRoomPosition(edge[0], edge[1], "W1N1"),
        new TestRoomPosition(next[0], next[1], "W1N2"),
      ],
      incomplete: false,
      ops: 20,
      cost: 20,
    });

    expect(travel(creep)).toBe(OK);
    Game.time += 1;
    relocate(creep, room, edge[0], edge[1]);
    expect(travel(creep)).toBe(OK);

    expect(creep.move).toHaveBeenLastCalledWith(exitDirection);
    expect(getMovementAnalyticsForTest().totals.multiRoomSegmentHits).toBe(1);
  });

  it("propagates a terminal cached transition move error after one invalidation", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room, 47);
    const search = useSuccessfulCurrentRoomSearch();

    expect(travel(creep)).toBe(OK);
    Game.time += 1;
    relocate(creep, room, 49);
    (creep.move as jest.Mock).mockReturnValueOnce(ERR_NO_BODYPART);

    expect(travel(creep)).toBe(ERR_NO_BODYPART);

    expect(creep.move).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenCalledTimes(1);
    expect(getCreepMovementState(creep)?.travelState?.multiRoomSegment).toBeUndefined();
    expect(getMovementAnalyticsForTest().totals).toMatchObject({
      multiRoomSegmentHits: 0,
      multiRoomSegmentInvalidations: 1,
    });
  });

  it.each([
    ["non-adjacent coordinates", new TestRoomPosition(0, 40, "W1N2")],
    ["wrong adjacent room", new TestRoomPosition(0, 25, "W9N9")],
  ])("does not cache an invalid transition with %s", (_label, transition) => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room, 47);
    (PathFinder.search as jest.Mock).mockReturnValue({
      path: [
        new TestRoomPosition(48, 25, "W1N1"),
        new TestRoomPosition(49, 25, "W1N1"),
        transition,
      ],
      incomplete: false,
      ops: 20,
      cost: 20,
    });

    expect(travel(creep)).toBe(OK);

    expect(getCreepMovementState(creep)?.travelState?.multiRoomSegment).toBeUndefined();
  });

  it("cold-starts safely after global reset without a Memory migration", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room);
    const search = useSuccessfulCurrentRoomSearch();
    const originalCreepMemory = { ...creep.memory };

    expect(travel(creep)).toBe(OK);
    clearCreepMovementStateForTest();
    Game.time += 1;
    relocate(creep, room, 11);
    expect(travel(creep)).toBe(OK);

    expect(search).toHaveBeenCalledTimes(2);
    expect(creep.memory).toEqual(originalCreepMemory);
    expect(getMovementAnalyticsForTest().totals.multiRoomSegmentInvalidations).toBe(0);
  });

  it("clears travel state when the creep reaches its target room", () => {
    const sourceRoom = createRoom("W1N1", "W1N2");
    const targetRoom = createRoom(DEFAULT_TARGET, "W1N2");
    Game.rooms[sourceRoom.name] = sourceRoom;
    Game.rooms[targetRoom.name] = targetRoom;
    const creep = createTravelCreep(sourceRoom);
    useSuccessfulCurrentRoomSearch();

    expect(travel(creep)).toBe(OK);
    expect(ensureCreepMovementState(creep.name).travelState?.multiRoomSegment).toBeDefined();
    Game.time += 1;
    relocate(creep, targetRoom, 25);

    expect(travel(creep)).toBe(OK);
    expect(getCreepMovementState(creep)?.travelState).toBeUndefined();
  });

  it("prunes arrival state even when the role stops calling travel after entering the target", () => {
    const sourceRoom = createRoom("W1N1", "W1N2");
    const targetRoom = createRoom(DEFAULT_TARGET, "W1N2");
    Game.rooms[sourceRoom.name] = sourceRoom;
    Game.rooms[targetRoom.name] = targetRoom;
    const creep = createTravelCreep(sourceRoom);
    useSuccessfulCurrentRoomSearch();

    expect(travel(creep)).toBe(OK);
    relocate(creep, targetRoom, 25);

    expect(pruneDeadCreepMovementState()).toBe(0);
    expect(getCreepMovementState(creep)?.travelState).toBeUndefined();
  });

  it("counts a periodic cleanup rejection of an expired live segment", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room);
    useSuccessfulCurrentRoomSearch();

    expect(travel(creep)).toBe(OK);
    const segment = getCreepMovementState(creep)?.travelState?.multiRoomSegment;
    Game.time = segment!.expiresAt;

    expect(pruneDeadCreepMovementState()).toBe(0);
    expect(getCreepMovementState(creep)?.travelState?.multiRoomSegment).toBeUndefined();
    expect(getMovementAnalyticsForTest().totals.multiRoomSegmentInvalidations).toBe(1);
    expect(getMovementAnalyticsForTest().rooms.W1N1.multiRoomSegmentInvalidations).toBe(1);
  });

  it("removes a segment through explicit clear and dead-owner cleanup", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room);
    useSuccessfulCurrentRoomSearch();

    expect(travel(creep)).toBe(OK);
    clearCreepMovementState(creep);
    expect(getCreepMovementState(creep)).toBeUndefined();

    expect(travel(creep)).toBe(OK);
    delete Game.creeps[creep.name];
    expect(pruneDeadCreepMovementState()).toBe(1);
    expect(getCreepMovementState(creep)).toBeUndefined();
  });

  it("keeps the closest-exit and single-room fallback when multi-room search fails", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room);
    (PathFinder.search as jest.Mock).mockReturnValue({ path: [], incomplete: true, ops: 20, cost: 0 });
    const position = creep.pos as PositionWithFallbackSpies;

    expect(travel(creep)).toBe(OK);

    expect(PathFinder.search).toHaveBeenCalledTimes(1);
    expect(position.findClosestByPath).toHaveBeenCalledWith(RIGHT);
    expect(position.findPathTo).toHaveBeenCalledTimes(1);
    expect(creep.move).toHaveBeenCalledWith(RIGHT);
    expect(getCreepMovementState(creep)?.travelState?.multiRoomSegment).toBeUndefined();
  });

  it.each([
    ["non-adjacent", new TestRoomPosition(30, 30, "W1N1")],
    ["duplicate origin", new TestRoomPosition(10, 25, "W1N1")],
  ])("falls back when a nominally successful search starts with a %s step", (_label, firstStep) => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room);
    const position = creep.pos as PositionWithFallbackSpies;
    (PathFinder.search as jest.Mock).mockReturnValue({
      path: [firstStep],
      incomplete: false,
      ops: 20,
      cost: 20,
    });

    expect(travel(creep)).toBe(OK);

    expect(position.findClosestByPath).toHaveBeenCalledWith(RIGHT);
    expect(position.findPathTo).toHaveBeenCalledTimes(1);
    expect(getCreepMovementState(creep)?.travelState?.multiRoomSegment).toBeUndefined();
  });

  it("keeps a fixed Colonization cached path ahead of fresh segment search", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room);
    const routeRooms = DEFAULT_ROUTE.split("|");
    const cachedTravelPath = {
      key: getColonizationTravelPathKey("W1N1", DEFAULT_TARGET, routeRooms, []),
      sourceRoom: "W1N1",
      targetRoom: DEFAULT_TARGET,
      routeRooms,
      positions: [
        { x: 10, y: 25, roomName: "W1N1" },
        { x: 11, y: 25, roomName: "W1N1" },
      ],
      generatedAt: Game.time,
    };
    Memory.data = {
      colonization: {
        [DEFAULT_TARGET]: { cachedTravelPath },
      },
    } as unknown as Memory["data"];

    expect(travel(creep)).toBe(OK);

    expect(PathFinder.search).not.toHaveBeenCalled();
    expect(creep.move).toHaveBeenCalledWith(RIGHT);
    expect(getCreepMovementState(creep)?.travelState?.multiRoomSegment).toBeUndefined();
  });

  it("releases an existing segment when a persistent Colonization path appears", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room);
    const search = useSuccessfulCurrentRoomSearch();

    expect(travel(creep)).toBe(OK);
    expect(getCreepMovementState(creep)?.travelState?.multiRoomSegment).toBeDefined();
    Game.time += 1;
    relocate(creep, room, 11);
    const routeRooms = DEFAULT_ROUTE.split("|");
    Memory.data = {
      colonization: {
        [DEFAULT_TARGET]: {
          cachedTravelPath: {
            key: getColonizationTravelPathKey("W1N1", DEFAULT_TARGET, routeRooms, []),
            sourceRoom: "W1N1",
            targetRoom: DEFAULT_TARGET,
            routeRooms,
            positions: [
              { x: 11, y: 25, roomName: "W1N1" },
              { x: 12, y: 25, roomName: "W1N1" },
            ],
            generatedAt: Game.time,
          },
        },
      },
    } as unknown as Memory["data"];

    expect(travel(creep)).toBe(OK);

    expect(search).toHaveBeenCalledTimes(1);
    expect(getCreepMovementState(creep)?.travelState?.multiRoomSegment).toBeUndefined();
    expect(getMovementAnalyticsForTest().totals.multiRoomSegmentInvalidations).toBe(1);
  });

  it("keeps using the segment when a persistent Colonization path cannot reattach", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room);
    const search = useSuccessfulCurrentRoomSearch();

    expect(travel(creep)).toBe(OK);
    const routeRooms = DEFAULT_ROUTE.split("|");
    Memory.data = {
      colonization: {
        [DEFAULT_TARGET]: {
          cachedTravelPath: {
            key: getColonizationTravelPathKey("W1N1", DEFAULT_TARGET, routeRooms, []),
            sourceRoom: "W1N1",
            targetRoom: DEFAULT_TARGET,
            routeRooms,
            positions: [
              { x: 30, y: 25, roomName: "W1N1" },
              { x: 31, y: 25, roomName: "W1N1" },
            ],
            generatedAt: Game.time,
          },
        },
      },
    } as unknown as Memory["data"];

    Game.time += 1;
    relocate(creep, room, 11);
    expect(travel(creep)).toBe(OK);
    Game.time += 1;
    relocate(creep, room, 12);
    expect(travel(creep)).toBe(OK);

    expect(search).toHaveBeenCalledTimes(1);
    expect(getCreepMovementState(creep)?.travelState?.multiRoomSegment).toBeDefined();
    expect(getMovementAnalyticsForTest().totals).toMatchObject({
      multiRoomSegmentHits: 2,
      multiRoomSegmentInvalidations: 0,
    });
  });

  it("preserves a traffic move result instead of swallowing it into fallback", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room);
    (creep.move as jest.Mock).mockReturnValue(ERR_BUSY);
    useSuccessfulCurrentRoomSearch();
    const position = creep.pos as PositionWithFallbackSpies;

    expect(travel(creep)).toBe(ERR_BUSY);

    expect(PathFinder.search).toHaveBeenCalledTimes(1);
    expect(position.findClosestByPath).not.toHaveBeenCalled();
    expect(position.findPathTo).not.toHaveBeenCalled();
  });

  it.each([ERR_BUSY, ERR_TIRED])("counts cached follower result %s as a hit without falling back", (moveResult) => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room);
    const search = useSuccessfulCurrentRoomSearch();
    const position = creep.pos as PositionWithFallbackSpies;

    expect(travel(creep)).toBe(OK);
    Game.time += 1;
    relocate(creep, room, 11);
    (creep.move as jest.Mock).mockReturnValueOnce(moveResult);

    expect(travel(creep)).toBe(moveResult);
    expect(search).toHaveBeenCalledTimes(1);
    expect(position.findClosestByPath).not.toHaveBeenCalled();
    expect(position.findPathTo).not.toHaveBeenCalled();
    expect(getMovementAnalyticsForTest().totals.multiRoomSegmentHits).toBe(1);
  });

  it("counts traffic-level ERR_BUSY as cache reuse without claiming physical progress", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room);
    const search = useSuccessfulCurrentRoomSearch();

    expect(travel(creep)).toBe(OK);
    const pusherMoveCalls = (creep.move as jest.Mock).mock.calls.length;
    Game.time += 1;
    const blocker = createTravelCreep(room, 11, 25, "blocker");
    (blocker.move as jest.Mock).mockReturnValue(ERR_BUSY);

    expect(travel(creep)).toBe(ERR_BUSY);

    expect(search).toHaveBeenCalledTimes(1);
    expect(creep.move).toHaveBeenCalledTimes(pusherMoveCalls);
    expect(blocker.move).toHaveBeenCalled();
    expect(getMovementAnalyticsForTest().totals.multiRoomSegmentHits).toBe(1);
  });

  it("records one search and three successful hits in totals and the request room", () => {
    const room = createRoom("W1N1", "W1N2");
    Game.rooms[room.name] = room;
    const creep = createTravelCreep(room);
    useSuccessfulCurrentRoomSearch();

    for (let tick = 0; tick < 4; tick += 1) {
      if (tick > 0) {
        Game.time += 1;
        relocate(creep, room, 10 + tick);
      }
      expect(travel(creep)).toBe(OK);
    }

    const analytics = getMovementAnalyticsForTest();
    expect(analytics.totals).toMatchObject({
      multiRoomSearches: 1,
      multiRoomSegmentHits: 3,
      multiRoomSegmentInvalidations: 0,
    });
    expect(analytics.rooms.W1N1).toMatchObject({
      multiRoomSearches: 1,
      multiRoomSegmentHits: 3,
      multiRoomSegmentInvalidations: 0,
    });
  });
});
