import { searchSingleRoom } from "@mock/roomPathFinder";
import {
  clearMovementAnalyticsForTest,
  clearRoomBaseCostMatrixCacheForTest,
  moveToTarget,
} from "@/roles/shared";
import { clearCreepMovementStateForTest, ensureCreepMovementState, getCreepMovementState } from "@/movement";

type RuntimeGlobal = typeof global & {
  __runtimeServices?: unknown;
  Room?: {
    serializePath(path: Array<{ direction: DirectionConstant }>): string;
  };
};

class MockRoomPosition {
  constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}

  getRangeTo(target: RoomPosition | { x: number; y: number } | number, y?: number): number {
    if (typeof target === "number") {
      return Math.max(Math.abs(this.x - target), Math.abs(this.y - (y ?? this.y)));
    }

    return Math.max(Math.abs(this.x - target.x), Math.abs(this.y - target.y));
  }

  getDirectionTo(target: RoomPosition | { x: number; y: number }): DirectionConstant {
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

  findPathTo(): PathStep[] {
    return [];
  }
}

class MockCostMatrix {
  private readonly values = new Map<string, number>();

  set(x: number, y: number, value: number): void {
    this.values.set(`${x}:${y}`, value);
  }

  get(x: number, y: number): number {
    return this.values.get(`${x}:${y}`) ?? 0;
  }

  clone(): MockCostMatrix {
    const clone = new MockCostMatrix();
    for (const [key, value] of this.values.entries()) {
      clone.values.set(key, value);
    }
    return clone;
  }
}

function resetRuntimeServices(): void {
  delete (global as RuntimeGlobal).__runtimeServices;
}

function createRoom(name = "W1N1", creeps: Creep[] = []): Room {
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

function setDefaultMapMocks(): void {
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

function createCreep(name: string, role: CreepMemory["role"], x: number, y: number, room: Room): Creep {
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

describe("moveToTarget yielding", () => {
  beforeEach(() => {
    resetRuntimeServices();
    clearCreepMovementStateForTest();
    clearMovementAnalyticsForTest();
    clearRoomBaseCostMatrixCacheForTest();
    Game.time += 1;
    Game.rooms = {};
    Game.creeps = {};
    setDefaultMapMocks();
    (global as RuntimeGlobal).Room = {
      serializePath: jest.fn((path: Array<{ direction: DirectionConstant }>) => path.map((step) => step.direction).join("")),
    };
    Object.assign(global, {
      PathFinder: {
        search: jest.fn(searchSingleRoom),
        CostMatrix: MockCostMatrix,
      },
    });
    (global as typeof global & { RoomPosition: typeof MockRoomPosition }).RoomPosition = MockRoomPosition;
  });

  it("returns ERR_BUSY when a stationary blocker returns ERR_TIRED on push", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N5D", creeps);
    const pusher = createCreep("worker-tired-push2", "worker", 10, 10, room);
    const blocker = createCreep("carrier-tired-block2", "carrier", 11, 10, room);
    (blocker.move as jest.Mock).mockReturnValue(ERR_TIRED);
    creeps.push(pusher, blocker);
    Game.creeps[pusher.name] = pusher;
    Game.creeps[blocker.name] = blocker;

    (pusher.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(() => [
      { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
      { x: 12, y: 10, dx: 1, dy: 0, direction: RIGHT },
    ]);

    const result = moveToTarget(pusher, { pos: new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition });

    expect(result).toBe(ERR_BUSY);
    expect(blocker.move).toHaveBeenCalled();
    expect(getCreepMovementState(blocker.name)?.movementPushedAt).toBeUndefined();
  });

  it("drops a legacy cached path state without steps and repaths safely", () => {
    const creeps: Creep[] = [];
    const room = createRoom("W1N2A", creeps);
    const creep = createCreep("worker-legacy", "worker", 10, 10, room);
    creeps.push(creep);
    Game.creeps[creep.name] = creep;
    ensureCreepMovementState(creep.name).movePathState = {
      key: `${room.name}:${room.name}:12:10:r1:i0:sd:pd:md`,
      path: "33",
      targetRoom: room.name,
      targetX: 12,
      targetY: 10,
      range: 1,
      stuckTicks: 0,
      expiresAt: Game.time + 5,
    } as unknown as import("@/movement/types").MovePathState;
    (creep.pos as unknown as { findPathTo: jest.Mock }).findPathTo = jest.fn(() => [
      { x: 11, y: 10, dx: 1, dy: 0, direction: RIGHT },
      { x: 12, y: 10, dx: 1, dy: 0, direction: RIGHT },
    ]);

    const result = moveToTarget(creep, { pos: new MockRoomPosition(12, 10, room.name) as unknown as RoomPosition });

    expect(result).toBe(OK);
    expect(creep.move).toHaveBeenCalledWith(RIGHT);
    expect((getCreepMovementState(creep.name)?.movePathState?.steps || [])[0]).toEqual({ x: 11, y: 10 });
  });
});
