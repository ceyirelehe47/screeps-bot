jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(),
}));
jest.mock("@/runtime/roomPlannerConstruction", () => ({
  getPlannedSourceContainerPos: jest.fn(),
}));
jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepIntent: jest.fn((fn: () => number) => fn()),
}));

import { harvesterRole } from "@/roles/harvester";
import { moveToTarget } from "@/roles/shared";
import { getPlannedSourceContainerPos } from "@/runtime/roomPlannerConstruction";

// ---------------------------------------------------------------------------
// Minimal mocks
// ---------------------------------------------------------------------------

class MockPos {
  x: number;
  y: number;
  roomName: string;
  private _lookFor: Record<string, unknown[]> = {};

  constructor(x: number, y: number, roomName: string) {
    this.x = x;
    this.y = y;
    this.roomName = roomName;
  }

  isEqualTo(other: MockPos): boolean {
    return this.x === other.x && this.y === other.y;
  }

  inRangeTo(target: MockPos, range: number): boolean {
    return Math.max(Math.abs(this.x - target.x), Math.abs(this.y - target.y)) <= range;
  }

  lookFor(type: string): unknown[] {
    return this._lookFor[type] ?? [];
  }

  setLookFor(type: string, items: unknown[]): void {
    this._lookFor[type] = items;
  }

  findInRange(_find: number, _range: number, _opts?: unknown): unknown[] {
    return [];
  }
}

function makeSource(id: string, x: number, y: number, roomName: string) {
  return { id: id as Id<Source>, pos: new MockPos(x, y, roomName), room: { name: roomName } };
}

function makeCreep(x: number, y: number, roomName: string) {
  return {
    pos: new MockPos(x, y, roomName),
    room: { name: roomName },
    my: true,
    memory: { role: "harvester" },
    harvest: jest.fn() as jest.Mock<number, [unknown]>,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const ROOM = "W5N5";
const SOURCE_ID = "srcId";

let source: ReturnType<typeof makeSource>;
let workPos: MockPos;

beforeEach(() => {
  jest.clearAllMocks();
  source = makeSource(SOURCE_ID, 10, 10, ROOM);
  workPos = new MockPos(11, 10, ROOM);
  (Game as unknown as { getObjectById: jest.Mock }).getObjectById = jest.fn().mockReturnValue(source);
  (getPlannedSourceContainerPos as jest.Mock).mockReturnValue(workPos);
  Object.assign(global, { RoomPosition: MockPos });
});

// ---------------------------------------------------------------------------
// Scenario: pre-spawn overlap — two harvesters for the same source
//
//   H1 (old, expiring) is already sitting on workPos.
//   H2 (new replacement) is spawned and also gets the same workPos.
//
// Without fix: H2 calls moveToTarget(workPos, range=0) every tick → they fight.
// With fix:    H2 skips the move when workPos is occupied, harvests or moves
//              toward the source instead.
// ---------------------------------------------------------------------------

describe("harvesterRole – pre-spawn overlap (two harvesters for same source)", () => {
  test("occupied workPos: creep in harvest range does not call moveToTarget with workPos", () => {
    // Simulate old harvester sitting on workPos
    workPos.setLookFor(LOOK_CREEPS, [{ my: true }]);

    // New harvester is adjacent to source — can harvest from its current tile
    const creep = makeCreep(10, 11, ROOM);
    creep.harvest.mockReturnValue(OK);

    const role = harvesterRole(SOURCE_ID);
    role.source(creep as unknown as Creep);

    expect(moveToTarget).not.toHaveBeenCalledWith(creep, workPos, 0, expect.anything());
  });

  test("occupied workPos: creep out of harvest range moves toward workPos (range 1)", () => {
    workPos.setLookFor(LOOK_CREEPS, [{ my: true }]);

    const creep = makeCreep(5, 5, ROOM);
    creep.harvest.mockReturnValue(ERR_NOT_IN_RANGE);

    const role = harvesterRole(SOURCE_ID);
    role.source(creep as unknown as Creep);

    // Moves toward workPos with range 1 instead of toward source
    expect(moveToTarget).toHaveBeenCalledWith(creep, workPos, 1, { reusePath: 5 });
    expect(moveToTarget).not.toHaveBeenCalledWith(creep, source);
  });
});
