import { searchSingleRoom } from "@mock/roomPathFinder";
import { getCreepMovementState } from "@/movement/creepState";
import { clearCreepMovementStateForTest } from "@/movement/creepState";
import { moveToTargetRoom, clearRoutingCachesForTest } from "@/movement/routing";
import { getMoveIntentReceipt } from "@/movement/traffic";

jest.mock("@/runtime/sourceWorkPosition", () => ({
  getSourceContainerPositionsForRoom: jest.fn(() => []),
}));

class MockRoomPosition {
  constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}

  public getRangeTo(target: RoomPosition | number, y?: number): number {
    const targetX = typeof target === "number" ? target : target.x;
    const targetY = typeof target === "number" ? y ?? this.y : target.y;
    return Math.max(Math.abs(this.x - targetX), Math.abs(this.y - targetY));
  }

  public getDirectionTo(target: RoomPosition): DirectionConstant {
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

  public findClosestByPath(direction: DirectionConstant): RoomPosition | null {
    return new MockRoomPosition(direction === RIGHT ? 49 : direction === LEFT ? 0 : this.x, direction === TOP ? 0 : direction === BOTTOM ? 49 : this.y, this.roomName) as unknown as RoomPosition;
  }

  public findPathTo(): PathStep[] { return []; }
}

class RealCostMatrix {
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

describe("moveToTargetRoom", () => {
  beforeEach(() => {
    clearCreepMovementStateForTest();
    clearRoutingCachesForTest();
    Game.time += 1;
    Memory.data = undefined;

    Object.assign(global, {
      RoomPosition: MockRoomPosition,
    });

    Object.assign(Game, {
      map: {
        getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) })),
        getRoomStatus: jest.fn(() => ({ status: "normal", timestamp: null })),
        findRoute: jest.fn(() => [{ exit: RIGHT, room: "W1N2" }]),
        describeExits: jest.fn((roomName: string) => {
          if (roomName === "W1N1") {
            return { [RIGHT]: "W1N2" };
          }
          if (roomName === "W1N2") {
            return { [LEFT]: "W1N1", [RIGHT]: "W1N3" };
          }
          if (roomName === "W1N3") {
            return { [LEFT]: "W1N2" };
          }
          return null;
        }),
      },
    });

    Object.assign(global, {
      PathFinder: {
        search: jest.fn(searchSingleRoom),
        CostMatrix: RealCostMatrix as unknown as typeof PathFinder.CostMatrix,
      },
      Room: {
        serializePath: jest.fn((path: Array<{ direction: DirectionConstant }>) => path.map((step) => step.direction).join("")),
      },
    });
  });

  function interiorCreep(name: string): Creep {
    const room = { name: "W1N1", find: jest.fn(() => []), findExitTo: jest.fn(() => RIGHT) } as unknown as Room;
    Game.rooms = { [room.name]: room }; Game.creeps = {}; Game.spawns = {};
    return { name, room, memory: { role: "remoteCarrier" }, fatigue: 0, body: [{ type: MOVE, hits: 100 }],
      pos: new MockRoomPosition(25, 25, room.name), move: jest.fn(() => OK), moveTo: jest.fn(() => ERR_NO_PATH) } as unknown as Creep;
  }

  it("出口目标与路径都遵守同一危险矩阵，禁止最近落点后选择另一出口", () => {
    const creep = interiorCreep("safe-exit");
    const unsafe = new MockRoomPosition(49, 20, "W1N1") as unknown as RoomPosition;
    const safe = new MockRoomPosition(49, 30, "W1N1") as unknown as RoomPosition;
    expect(moveToTargetRoom(creep, "W1N2", undefined, { routePolicyKey: "salvage", routeRoomCost: () => 1,
      costCallback: (_room, matrix) => { matrix.set(49, 20, 255); return matrix; } })).toBe(OK);
    const goals = (PathFinder.search as jest.Mock).mock.calls[0][1] as Array<{ pos: RoomPosition }>;
    expect(goals.some(goal => goal.pos.isEqualTo(unsafe))).toBe(false);
    expect(goals.some(goal => goal.pos.isEqualTo(safe))).toBe(true);
    const matrix = (PathFinder.search as jest.Mock).mock.calls[0][2].roomCallback("W1N1") as CostMatrix;
    expect(matrix.get(49, 20)).toBe(255);
    expect(matrix.get(0, 20)).toBe(255);
    expect(creep.move).toHaveBeenCalledTimes(1);
  });

  it("一条出口无安全落点时短暂排除此有向通道，仍可从另一个入口到目标房", () => {
    const creep = interiorCreep("alternate-entry");
    const callbackCosts: number[] = [];
    Game.map.findRoute = jest.fn((_from, _to, opts) => {
      const direct = opts!.routeCallback!("W1N2", "W1N1"); callbackCosts.push(direct);
      return Number.isFinite(direct) ? [{ exit: RIGHT, room: "W1N2" }] : [{ exit: TOP, room: "W1N0" }, { exit: RIGHT, room: "W1N2" }];
    });
    Game.map.describeExits = jest.fn(() => ({ [RIGHT]: "W1N2", [TOP]: "W1N0" }));
    const opts = { routePolicyKey: "salvage", routeRoomCost: () => 1,
      costCallback: (_room: string, matrix: CostMatrix) => { for (let y = 0; y < 50; y++) matrix.set(49, y, 255); return matrix; } };
    expect(moveToTargetRoom(creep, "W1N2", undefined, opts)).toBe(ERR_NO_PATH);
    Game.time++; expect(moveToTargetRoom(creep, "W1N2", undefined, opts)).toBe(OK);
    expect(callbackCosts).toEqual([1, Infinity]);
    expect(getCreepMovementState(creep)!.travelState!.exitTarget?.y).toBe(0);
    expect(creep.move).toHaveBeenCalledWith(TOP);
  });

  it("业务路线缓存与普通路线隔离，缓存命中也复核目标房的当前危险", () => {
    const creep = interiorCreep("policy-cache");
    moveToTargetRoom(creep, "W1N2");
    let safe = true;
    Game.map.findRoute = jest.fn((_from, _to, opts) => Number.isFinite(opts!.routeCallback!("W1N2", "W1N1"))
      ? [{ exit: RIGHT, room: "W1N2" }] : ERR_NO_PATH);
    const opts = { routePolicyKey: "salvage", routeRoomCost: () => safe ? 1 : Infinity };
    moveToTargetRoom(creep, "W1N2", undefined, opts);
    expect(Game.map.findRoute).toHaveBeenCalledTimes(1);
    safe = false; Game.time++;
    expect(moveToTargetRoom(creep, "W1N2", undefined, opts)).toBe(ERR_NO_PATH);
    expect(Game.map.findRoute).toHaveBeenCalledTimes(2);
  });

  it("moves outward when already standing on the selected exit tile", () => {
    const room = {
      name: "W1N1",
      findExitTo: jest.fn(() => RIGHT),
      find: jest.fn(() => [new MockRoomPosition(49, 25, "W1N1")]),
    } as unknown as Room;
    const move = jest.fn(() => OK);
    const moveTo = jest.fn(() => OK);
    const creep = {
      name: "scout1",
      fatigue: 0,
      room,
      pos: new MockRoomPosition(49, 25, "W1N1") as unknown as RoomPosition,
      move,
      moveTo,
    } as unknown as Creep;

    const result = moveToTargetRoom(creep, "W1N2", "W1N1|W1N2", { plainCost: 2, swampCost: 10 });

    expect(result).toBe(OK);
    expect(move).toHaveBeenCalledWith(RIGHT);
    expect(getMoveIntentReceipt(creep)).toEqual(expect.objectContaining({
      direction: RIGHT,
      from: { x: 49, y: 25, roomName: "W1N1" },
      to: { x: 0, y: 25, roomName: "W1N2" },
    }));
    expect(moveTo).not.toHaveBeenCalled();
  });

  it("moves off a wrong room edge before heading to the next route exit", () => {
    const room = {
      name: "W1N2",
      findExitTo: jest.fn(() => RIGHT),
      find: jest.fn((findConstant: number) => {
        if (findConstant === RIGHT) {
          return [new MockRoomPosition(49, 25, "W1N2")];
        }
        return [];
      }),
    } as unknown as Room;
    const move = jest.fn(() => OK);
    const moveTo = jest.fn(() => OK);
    const creep = {
      name: "scout-wrong-edge",
      fatigue: 0,
      room,
      pos: new MockRoomPosition(39, 0, "W1N2") as unknown as RoomPosition,
      move,
      moveTo,
    } as unknown as Creep;

    const result = moveToTargetRoom(creep, "W1N3", "W1N1|W1N2|W1N3", { plainCost: 2, swampCost: 10 });

    expect(result).toBe(OK);
    expect(move).toHaveBeenCalledWith(BOTTOM);
    expect(moveTo).not.toHaveBeenCalled();
  });
});
