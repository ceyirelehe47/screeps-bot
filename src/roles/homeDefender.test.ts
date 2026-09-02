import { homeDefenderRole } from "@/roles/homeDefender";
import { getAssignedDefenseFront, getDefenderRole, getTowerFocusFront } from "@/runtime/defenseCoordination";
import { getPlayerHostiles } from "@/runtime/defenseMode";
import { getSafeZone } from "@/runtime/safeZone";
import { createSafeZoneCostCallback, getBoundaryRamparts } from "@/runtime/safeZoneHelpers";
import { moveToTarget } from "@/roles/shared";

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

  it("【Remediation II】显式计划目标优先：贴身按计划目标 attack（旧独立评分/去重不得改目标）", () => {
    Game.time = 5;
    const plannedTarget = createHostile("planned", 10, 11, 80);
    const otherTarget = createHostile("other", 10, 10, 100);
    const defender = {
      name: "defender-0",
      memory: { role: "homeDefender" },
      body: [{ type: ATTACK }],
      pos: new MockPos(10, 11, "W1N1") as unknown as RoomPosition,
      attack: jest.fn(() => OK),
      rangedAttack: jest.fn(() => OK),
      moveTo: jest.fn(() => OK),
      getActiveBodyparts: jest.fn((part: BodyPartConstant) => (part === ATTACK ? 2 : 0)),
    } as unknown as Creep;
    const room = createRoom([defender]);
    Object.defineProperty(defender, "room", { value: room });
    (getPlayerHostiles as jest.Mock).mockReturnValue([plannedTarget, otherTarget]);
    (getAssignedDefenseFront as jest.Mock).mockReturnValue(null);
    (getTowerFocusFront as jest.Mock).mockReturnValue(null);
    Memory.runtime = {
      defenseEngagement: {
        W1N1: {
          roomName: "W1N1",
          plannedAtTick: Game.time,
          focusTargetId: "planned",
          killExpected: true,
          focusAssignedDamage: 0,
          focusExpectedHeal: 0,
          towerAssignments: {},
          defenderAssignments: { "0": "planned" },
          emergencyHealByTowerId: {},
        },
      },
    } as never;

    homeDefenderRole("W1N1", "0").target(defender);

    expect(defender.attack).toHaveBeenCalledWith(plannedTarget);
    expect(defender.attack).not.toHaveBeenCalledWith(otherTarget);
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("【Remediation II】纯远程防御者按计划目标 rangedAttack（与 planner 计入的伤害一致）", () => {
    Game.time = 6;
    const plannedTarget = createHostile("planned", 10, 13, 300);
    const defender = {
      name: "defender-1",
      memory: { role: "homeDefender" },
      body: [{ type: RANGED_ATTACK }],
      pos: new MockPos(10, 11, "W1N1") as unknown as RoomPosition,
      attack: jest.fn(() => OK),
      rangedAttack: jest.fn(() => OK),
      moveTo: jest.fn(() => OK),
      getActiveBodyparts: jest.fn((part: BodyPartConstant) => (part === RANGED_ATTACK ? 2 : 0)),
    } as unknown as Creep;
    const room = createRoom([defender]);
    Object.defineProperty(defender, "room", { value: room });
    (getPlayerHostiles as jest.Mock).mockReturnValue([plannedTarget]);
    (getAssignedDefenseFront as jest.Mock).mockReturnValue(null);
    (getTowerFocusFront as jest.Mock).mockReturnValue(null);
    Memory.runtime = {
      defenseEngagement: {
        W1N1: {
          roomName: "W1N1",
          plannedAtTick: Game.time,
          focusTargetId: "planned",
          killExpected: true,
          focusAssignedDamage: 0,
          focusExpectedHeal: 0,
          towerAssignments: {},
          defenderAssignments: { "0": "planned" },
          emergencyHealByTowerId: {},
        },
      },
    } as never;

    homeDefenderRole("W1N1", "0").target(defender);

    // range 2 ≤ 3 且无 ATTACK 部件 → rangedAttack 计划目标（planner 同口径
    // 计入 rangedDamage）；不调用 attack。
    expect(defender.rangedAttack).toHaveBeenCalledWith(plannedTarget);
    expect(defender.attack).not.toHaveBeenCalled();
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it("【Remediation II】计划目标不可即时攻击 → 本 tick 伤害为 0 且移动朝共享目标（不走 coverage rampart）", () => {
    Game.time = 7;
    const plannedTarget = createHostile("planned", 20, 20, 300);
    const rampart = createRampart(12, 10);
    const defender = {
      name: "defender-0",
      memory: { role: "homeDefender" },
      body: [{ type: ATTACK }],
      pos: new MockPos(12, 10, "W1N1") as unknown as RoomPosition,
      attack: jest.fn(() => OK),
      rangedAttack: jest.fn(() => OK),
      moveTo: jest.fn(() => OK),
      getActiveBodyparts: jest.fn((part: BodyPartConstant) => (part === ATTACK ? 1 : 0)),
    } as unknown as Creep;
    const room = createRoom([defender]);
    Object.defineProperty(defender, "room", { value: room });
    (getPlayerHostiles as jest.Mock).mockReturnValue([plannedTarget]);
    (getAssignedDefenseFront as jest.Mock).mockReturnValue(null);
    (getTowerFocusFront as jest.Mock).mockReturnValue(null);
    (getBoundaryRamparts as jest.Mock).mockReturnValue([rampart]);
    (getDefenderRole as jest.Mock).mockReturnValue("secondary");
    Memory.runtime = {
      defenseEngagement: {
        W1N1: {
          roomName: "W1N1",
          plannedAtTick: Game.time,
          focusTargetId: "planned",
          killExpected: true,
          focusAssignedDamage: 0,
          focusExpectedHeal: 0,
          towerAssignments: {},
          defenderAssignments: { "0": "planned" },
          emergencyHealByTowerId: {},
        },
      },
    } as never;

    homeDefenderRole("W1N1", "0").target(defender);

    // 需要移动（range 10）→ 本 tick 伤害 0、移动朝共享计划目标；不执行
    // attack/rangedAttack，也不进入旧的 coverage rampart 分支。
    expect(defender.attack).not.toHaveBeenCalled();
    expect(defender.rangedAttack).not.toHaveBeenCalled();
    expect(moveToTarget).toHaveBeenCalledTimes(1);
    expect(moveToTarget).toHaveBeenCalledWith(defender, plannedTarget, 1, expect.anything());
  });
});
