import { homeDefenderRole } from "@/roles/homeDefender";
import { getAssignedDefenseFront, getDefenderRole, getTowerFocusFront, getTowerBurstTarget } from "@/runtime/defenseCoordination";
import { getPlayerHostiles } from "@/runtime/defenseMode";
import { getSafeZone } from "@/runtime/safeZone";
import { createSafeZoneCostCallback, getBoundaryRamparts } from "@/runtime/safeZoneHelpers";

jest.mock("@/runtime/safeZone", () => ({
  getSafeZone: jest.fn(),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepDecision: jest.fn((fn: () => unknown) => fn()),
  measureCreepIntent: jest.fn((fn: () => unknown) => fn()),
}));

jest.mock("@/runtime/defenseCoordination", () => ({
  getAssignedDefenseFront: jest.fn(),
  getDefenderRole: jest.fn(),
  getTowerFocusFront: jest.fn(),
  getTowerBurstTarget: jest.fn(),
}));

jest.mock("@/runtime/defenseMode", () => ({
  getPlayerHostiles: jest.fn(),
}));

jest.mock("@/runtime/safeZoneHelpers", () => ({
  createSafeZoneCostCallback: jest.fn(() => jest.fn()),
  getBoundaryRamparts: jest.fn(),
}));

jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(() => OK),
  moveToTargetRoom: jest.fn(() => OK),
}));

class MockPos {
  public constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}

  public getRangeTo(target: { pos?: { x: number; y: number }; x?: number; y?: number }): number {
    const targetPos = "pos" in target && target.pos ? target.pos : target;
    return Math.max(Math.abs(this.x - (targetPos.x ?? 0)), Math.abs(this.y - (targetPos.y ?? 0)));
  }

  public isEqualTo(target: { x: number; y: number; roomName?: string }): boolean {
    return this.x === target.x && this.y === target.y && (!target.roomName || this.roomName === target.roomName);
  }

  public lookFor(): unknown[] {
    return [];
  }
}

function createHostile(id: string, x: number, y: number, hits = 100): Creep {
  return {
    id: id as Id<Creep>,
    hits,
    pos: new MockPos(x, y, "W1N1") as unknown as RoomPosition,
    getActiveBodyparts: jest.fn((part: BodyPartConstant) => (part === ATTACK ? 1 : 0)),
  } as unknown as Creep;
}

function createRampart(x: number, y: number): StructureRampart {
  return {
    id: `rampart-${x}-${y}` as Id<StructureRampart>,
    my: true,
    structureType: STRUCTURE_RAMPART,
    pos: new MockPos(x, y, "W1N1") as unknown as RoomPosition,
  } as StructureRampart;
}

function createRoom(myCreeps: Creep[]): Room {
  return {
    name: "W1N1",
    find: jest.fn((type: FindConstant) => {
      if (type === FIND_MY_CREEPS) return myCreeps;
      return [];
    }),
  } as unknown as Room;
}

describe("homeDefenderRole", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSafeZone as jest.Mock).mockReturnValue(new Set([10 * 50 + 10]));
    (createSafeZoneCostCallback as jest.Mock).mockReturnValue(jest.fn());
    (getDefenderRole as jest.Mock).mockReturnValue("primary");
    (getTowerFocusFront as jest.Mock).mockReturnValue(null);
    (getTowerBurstTarget as jest.Mock).mockReturnValue(undefined);
  });

  it("守在 rampart 的防御者优先攻击塔的当 tick 协同目标", () => {
    const focus = createHostile("tower-focus", 11, 10), other = createHostile("other", 10, 11);
    const rampart = createRampart(10, 10);
    const defender = { name: "defender", memory: { role: "homeDefender" }, pos: new MockPos(10, 10, "W1N1"), attack: jest.fn(() => OK) } as unknown as Creep;
    const room = createRoom([defender]);
    Object.defineProperty(defender, "room", { value: room });
    room.find = jest.fn((type: FindConstant) => type === FIND_MY_STRUCTURES ? [rampart] : []) as Room["find"];
    (getPlayerHostiles as jest.Mock).mockReturnValue([other, focus]);
    (getTowerBurstTarget as jest.Mock).mockReturnValue(focus.id);
    homeDefenderRole(room.name, "0").target(defender);
    expect(defender.attack).toHaveBeenCalledWith(focus);
  });

  it("attacks an adjacent hostile when the assigned boundary target retreats out of range", () => {
    const lockedTarget = createHostile("locked", 13, 10, 10);
    const reachableTarget = createHostile("reachable", 10, 11, 100);
    const rampart = createRampart(10, 10);
    const defender = {
      name: "defender-0",
      memory: { role: "homeDefender" },
      body: [{ type: ATTACK }],
      pos: new MockPos(10, 10, "W1N1") as unknown as RoomPosition,
      attack: jest.fn(() => OK),
      moveTo: jest.fn(() => OK),
    } as unknown as Creep;
    const room = createRoom([defender]);
    Object.defineProperty(defender, "room", { value: room });

    (getPlayerHostiles as jest.Mock).mockReturnValue([lockedTarget, reachableTarget]);
    (getAssignedDefenseFront as jest.Mock).mockReturnValue({
      id: "front:0",
      hostileIds: [lockedTarget.id],
      centroid: { x: lockedTarget.pos.x, y: lockedTarget.pos.y },
      threatScore: 1,
    });
    (getBoundaryRamparts as jest.Mock).mockReturnValue([rampart]);

    homeDefenderRole("W1N1", "0").target(defender);

    expect(defender.attack).toHaveBeenCalledWith(reachableTarget);
    expect(defender.attack).not.toHaveBeenCalledWith(lockedTarget);
  });

  it("never calls raw creep.moveTo", () => {
    const safeZone = new Set<number>();
    for (let x = 8; x <= 12; x++) {
      for (let y = 8; y <= 12; y++) {
        safeZone.add(x * 50 + y);
      }
    }
    (getSafeZone as jest.Mock).mockReturnValue(safeZone);

    const hostile = createHostile("h1", 14, 10);
    const rampart = createRampart(12, 10);
    const defender = {
      name: "defender-0",
      memory: { role: "homeDefender" },
      pos: new MockPos(12, 10, "W1N1") as unknown as RoomPosition,
      attack: jest.fn(() => OK),
      moveTo: jest.fn(() => OK),
    } as unknown as Creep;
    const room = createRoom([defender]);
    Object.defineProperty(defender, "room", { value: room });

    (getPlayerHostiles as jest.Mock).mockReturnValue([hostile]);
    (getAssignedDefenseFront as jest.Mock).mockReturnValue(null);
    (getTowerFocusFront as jest.Mock).mockReturnValue(null);
    (getBoundaryRamparts as jest.Mock).mockReturnValue([rampart]);

    homeDefenderRole("W1N1", "0").target(defender);

    expect(defender.moveTo).not.toHaveBeenCalled();
  });
});

it("专用 lab 每 tick 只强化一名防御者，敌人进核心区时优先战斗", () => {
  jest.clearAllMocks(); Game.time += 1;
  const room = createRoom([]);
  const makeDefender = (name: string) => ({ name, room, memory: { role: "homeDefender" },
    body: [{ type: ATTACK, hits: 100 }], pos: new MockPos(10, 11, room.name), attack: jest.fn(() => OK) } as unknown as Creep);
  const first = makeDefender("first"), second = makeDefender("second");
  const lab = { my: true, room, store: { getUsedCapacity: () => 300 }, boostCreep: jest.fn(() => OK) } as unknown as StructureLab;
  Memory.cfg = { homeDefense: { rooms: { W1N1: { boostLabId: "lab" } } } };
  Game.getObjectById = jest.fn(() => lab) as unknown as Game["getObjectById"];
  (getSafeZone as jest.Mock).mockReturnValue(new Set([10 * 50 + 10]));
  (getPlayerHostiles as jest.Mock).mockReturnValue([]);
  (getAssignedDefenseFront as jest.Mock).mockReturnValue(null);
  (getTowerFocusFront as jest.Mock).mockReturnValue(null);
  homeDefenderRole(room.name).target(first); homeDefenderRole(room.name).target(second);
  expect(lab.boostCreep).toHaveBeenCalledTimes(1);
  Game.time += 1;
  const hostile = createHostile("inside", 10, 10);
  (getPlayerHostiles as jest.Mock).mockReturnValue([hostile]);
  homeDefenderRole(room.name).target(second);
  expect(lab.boostCreep).toHaveBeenCalledTimes(1);
  expect(second.attack).toHaveBeenCalledWith(hostile);
  // 强化路径无解时继续在边界交战，不能被实验室永久拴住。
  Game.time += 1;
  const outside = createHostile("outside", 11, 11);
  (getPlayerHostiles as jest.Mock).mockReturnValue([outside]);
  (getBoundaryRamparts as jest.Mock).mockReturnValue([createRampart(10, 11)]);
  (lab.boostCreep as jest.Mock).mockReturnValue(ERR_NOT_IN_RANGE);
  const { moveToTarget } = jest.requireMock("@/roles/shared");
  moveToTarget.mockReturnValue(ERR_NO_PATH);
  homeDefenderRole(room.name).target(second);
  expect(second.attack).toHaveBeenCalledWith(outside);
  moveToTarget.mockReturnValue(OK);
});
