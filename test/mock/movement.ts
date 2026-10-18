import { findSingleRoomPath, searchSingleRoom } from "@mock/roomPathFinder";

/**
 * Shared movement test helpers for Jest.
 *
 * Consolidates duplicated MockRoomPosition, CostMatrix, room/creep factories,
 * and Game.map / PathFinder global setup from routing.test.ts, traffic.test.ts,
 * and shared.test.ts into reusable exports.
 */

// ---------------------------------------------------------------------------
// MockRoomPosition
// ---------------------------------------------------------------------------

export class MockRoomPosition {
  public constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}

  public getRangeTo(target: RoomPosition | { pos: RoomPosition } | number, y?: number): number {
    if (typeof target === "number") {
      return Math.max(Math.abs(this.x - target), Math.abs(this.y - (y ?? this.y)));
    }
    const pos = "pos" in target ? (target as { pos: RoomPosition }).pos : target;
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

  public findClosestByPath(): RoomPosition | null {
    return this as unknown as RoomPosition;
  }

  public findPathTo(target: RoomPosition | { pos: RoomPosition }, options: FindPathOpts = {}): PathStep[] {
    return findSingleRoomPath(this as unknown as RoomPosition, target, options);
  }
}

// ---------------------------------------------------------------------------
// CostMatrix implementations
// ---------------------------------------------------------------------------

/** Map-backed CostMatrix for lightweight tests. */
export class MockCostMatrix {
  private readonly values = new Map<string, number>();

  public set(x: number, y: number, value: number): void {
    this.values.set(`${x}:${y}`, value);
  }

  public get(x: number, y: number): number {
    return this.values.get(`${x}:${y}`) ?? 0;
  }

  public clone(): MockCostMatrix {
    const c = new MockCostMatrix();
    for (const [k, v] of this.values.entries()) {
      c.values.set(k, v);
    }
    return c;
  }
}

/** Uint8Array-backed CostMatrix matching real Screeps storage layout. */
export class RealCostMatrix {
  private data = new Uint8Array(2500);

  public set(x: number, y: number, value: number): void {
    this.data[y * 50 + x] = value;
  }

  public get(x: number, y: number): number {
    return this.data[y * 50 + x];
  }

  public clone(): RealCostMatrix {
    const copy = new RealCostMatrix();
    copy.data.set(this.data);
    return copy;
  }
}

// ---------------------------------------------------------------------------
// Global setup helpers
// ---------------------------------------------------------------------------

/** Install MockRoomPosition as global.RoomPosition. */
export function setupRoomPositionGlobal(): void {
  (global as typeof global & { RoomPosition: typeof MockRoomPosition }).RoomPosition = MockRoomPosition;
}

/** Set up default Game.map mocks (terrain, exits, route, status). */
export function setDefaultMapMocks(): void {
  Game.map = {
    getRoomTerrain: () => ({
      get: () => 0,
    }),
    describeExits: jest.fn(() => null),
    findRoute: jest.fn(() => ERR_NO_PATH),
    getRoomLinearDistance: jest.fn(() => 1),
    getRoomStatus: jest.fn(() => ({ status: "normal" })),
  } as unknown as GameMap;
}

/**
 * Install PathFinder and Room.serializePath globals.
 * @param costMatrixClass CostMatrix class to use (defaults to MockCostMatrix).
 */
export function setupPathFinderGlobal(costMatrixClass: new () => CostMatrix = MockCostMatrix as unknown as new () => CostMatrix): void {
  Object.assign(global, {
    PathFinder: {
      search: jest.fn(searchSingleRoom),
      CostMatrix: costMatrixClass,
    },
  });
  (global as typeof global & { Room?: unknown }).Room = {
    serializePath: jest.fn((path: Array<{ direction: DirectionConstant }>) => path.map((step) => step.direction).join("")),
  };
}

// ---------------------------------------------------------------------------
// Room / creep factories
// ---------------------------------------------------------------------------

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
};

/** Reset the runtime services singleton so modules reinitialise cleanly. */
export function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

/**
 * Create a minimal Room mock with jest.fn() for find().
 * The room is also registered in Game.rooms[name].
 */
export function createRoom(name = "W1N1", creeps: Creep[] = []): Room {
  const structures: Structure<StructureConstant>[] = [];
  const constructionSites: ConstructionSite[] = [];

  const room = {
    name,
    controller: { my: true } as StructureController,
    find: jest.fn((findConstant: number) => {
      switch (findConstant) {
        case FIND_STRUCTURES:
          return structures;
        case FIND_MY_STRUCTURES:
          return structures;
        case FIND_MY_CREEPS:
          return creeps;
        case FIND_CONSTRUCTION_SITES:
          return constructionSites;
        default:
          return [];
      }
    }),
  } as unknown as Room;

  Game.rooms[name] = room;
  return room;
}

/**
 * Create a full creep mock with pos, room, fatigue, memory, move, moveTo,
 * findClosestByPath, findClosestByRange.
 */
export function createCreep(name: string, role: CreepMemory["role"], x: number, y: number, room: Room): Creep {
  const pos = new MockRoomPosition(x, y, room.name) as unknown as RoomPosition;
  return {
    name,
    room,
    pos,
    fatigue: 0,
    memory: { role },
    move: jest.fn(() => OK),
    moveTo: jest.fn(() => OK),
    findClosestByPath: jest.fn(),
    findClosestByRange: jest.fn(),
  } as unknown as Creep;
}

/**
 * Create a minimal creep mock suitable for traffic/adjacent-position tests.
 */
export function makeCreep(name: string, x: number, y: number, roomName = "W1N1"): Creep {
  const pos = new MockRoomPosition(x, y, roomName) as unknown as RoomPosition;
  return {
    name,
    pos,
    room: { name: roomName } as Room,
    move: jest.fn(() => OK),
    memory: {},
  } as unknown as Creep;
}
