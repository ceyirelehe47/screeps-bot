jest.mock("@/roles/shared", () => ({
  clearMovementState: jest.fn(),
  moveToTarget: jest.fn(() => OK),
  moveToTargetRoom: jest.fn(() => OK),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepDecision: (fn: () => unknown) => fn(),
  measureCreepIntent: (fn: () => unknown) => fn(),
}));

jest.mock("@/movement/traffic", () => ({
  moveOffExit: jest.fn(() => OK),
}));

import { meleeAttackerRole } from "@/roles/meleeAttacker";
import { createMockPowerBankCreep } from "@mock/powerBank";

const { moveToTarget, moveToTargetRoom } = jest.requireMock("@/roles/shared") as {
  moveToTarget: jest.Mock;
  moveToTargetRoom: jest.Mock;
};
const TARGET_ROOM = "E3N57";
const ATTACKER_CONFIG = "E1N57:war:E3N57:meleeAttacker:0";
const HEALER_CONFIG = "E1N57:war:E3N57:healer:0";

function hostileCreep(name: string, hits: number, parts: Partial<Record<BodyPartConstant, number>> = {}): Creep {
  return {
    id: name as Id<Creep>,
    name,
    owner: { username: "TooAngel" },
    hits,
    pos: { x: 26, y: 25, roomName: "E2N57", getRangeTo: jest.fn(() => 1) } as unknown as RoomPosition,
    getActiveBodyparts: jest.fn((part: BodyPartConstant) => parts[part] ?? 0),
  } as unknown as Creep;
}

function hostileStructure(type: StructureConstant, id: string, x: number, y: number, hits = 3000): Structure {
  return {
    id: id as Id<Structure>,
    structureType: type,
    hits,
    hitsMax: hits,
    pos: { x, y, roomName: TARGET_ROOM, getRangeTo: jest.fn(() => 1) } as unknown as RoomPosition,
  } as Structure;
}


describe("meleeAttackerRole war duo staging", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    moveToTarget.mockReturnValue(OK);
    moveToTargetRoom.mockReturnValue(OK);
    Game.creeps = {};
    Object.assign(global, {
      PathFinder: {
        CostMatrix: class {
          private readonly values = new Map<string, number>();

          public set(x: number, y: number, value: number): void {
            this.values.set(`${x}:${y}`, value);
          }

          public get(x: number, y: number): number {
            return this.values.get(`${x}:${y}`) ?? 0;
          }
        },
        search: jest.fn(),
      },
    });
  });

  it("does not wait for an implicit same-index healer when the producer declares no partner", () => {
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "standard-attacker-1",
      roomName: "E2N57",
      x: 25,
      y: 25,
      memory: {
        role: "meleeAttacker",
        configName: "E1N57:war:E3N57:meleeAttacker:1",
      },
    });
    Game.creeps = { [attacker.name]: attacker };

    meleeAttackerRole(TARGET_ROOM, "", "", "", "").source?.(attacker);

    expect(moveToTargetRoom).toHaveBeenCalledWith(
      attacker,
      TARGET_ROOM,
      "",
      expect.objectContaining({ plainCost: 2, swampCost: 8 }),
    );
  });

  it.each(["source", "target"] as const)(
    "keeps moving through a cleared room instead of attacking an adjacent wall in %s phase",
    (phase) => {
      const wall = hostileStructure(STRUCTURE_WALL, "leftover-wall", 25, 24, 500_000);
      const attacker = createMockPowerBankCreep("meleeAttacker", {
        roomName: TARGET_ROOM,
        x: 24,
        y: 24,
        memory: {
          role: "meleeAttacker",
          configName: ATTACKER_CONFIG,
          _warBreachTargetId: wall.id as Id<StructureWall>,
        },
      });
      attacker.pos.findInRange = jest.fn((type: FindConstant) =>
        type === FIND_STRUCTURES ? [wall] : [],
      ) as unknown as RoomPosition["findInRange"];
      Game.creeps = { [attacker.name]: attacker };

      const role = meleeAttackerRole("E2N54", "", "", "", "");
      if (phase === "source") role.source?.(attacker);
      else role.target(attacker);

      expect(moveToTargetRoom).toHaveBeenCalledWith(attacker, "E2N54", "", expect.any(Object));
      expect(attacker.attack).not.toHaveBeenCalled();
      expect(attacker.memory._warBreachTargetId).toBeUndefined();
    },
  );

  it("attacks an adjacent wall only when travel has no path", () => {
    moveToTargetRoom.mockReturnValue(ERR_NO_PATH);
    const wall = hostileStructure(STRUCTURE_WALL, "route-blocking-wall", 25, 24, 500_000);
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      roomName: TARGET_ROOM,
      x: 24,
      y: 24,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.pos.findInRange = jest.fn((type: FindConstant) =>
      type === FIND_STRUCTURES ? [wall] : [],
    ) as unknown as RoomPosition["findInRange"];
    Game.creeps = { [attacker.name]: attacker };

    meleeAttackerRole("E2N54", "", "", "", "").source?.(attacker);

    expect(attacker.attack).toHaveBeenCalledWith(wall);
    expect(attacker.memory._warBreachTargetId).toBe(wall.id);
  });

  it("focuses hostile spawn before non-adjacent creeps and towers for war objectives", () => {
    const hostile = hostileCreep("hostile-defender", 800, { [ATTACK]: 5 });
    const spawn = hostileStructure(STRUCTURE_SPAWN, "spawn-war-objective", 20, 20, 5000);
    const tower = hostileStructure(STRUCTURE_TOWER, "tower-war-objective", 10, 10, 3000);
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 1,
      y: 1,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.room.find = jest.fn((type: FindConstant) => {
      if (type === FIND_HOSTILE_CREEPS) return [hostile];
      if (type === FIND_HOSTILE_STRUCTURES) return [tower, spawn];
      return [];
    }) as Room["find"];
    attacker.pos.findInRange = jest.fn(() => []) as unknown as RoomPosition["findInRange"];
    attacker.attack = jest.fn((target: Creep | Structure) => (target === spawn ? ERR_NOT_IN_RANGE : OK)) as Creep["attack"];
    Game.creeps = { attacker, healer: createMockPowerBankCreep("healer", { name: "healer", roomName: TARGET_ROOM, x: 2, y: 1, memory: { role: "healer", configName: HEALER_CONFIG } }) };

    meleeAttackerRole(TARGET_ROOM, "", "", "", HEALER_CONFIG).target(attacker);

    expect(attacker.attack).toHaveBeenCalledWith(spawn);
    expect(attacker.attack).not.toHaveBeenCalledWith(hostile);
    expect(attacker.attack).not.toHaveBeenCalledWith(tower);
    expect(moveToTarget).toHaveBeenCalledWith(
      attacker,
      spawn,
      1,
      expect.objectContaining({
        plainCost: 2,
        swampCost: 8,
        maxRooms: 1,
        ignoreCreeps: false,
        reusePath: 0,
      }),
    );
    expect((attacker.memory as CreepMemory & { _warMoveIntentAt?: number })._warMoveIntentAt).toBe(Game.time);
  });
});
