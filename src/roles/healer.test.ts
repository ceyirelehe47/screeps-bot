jest.mock("@/roles/shared", () => ({
  clearMovementState: jest.fn(),
  moveToTarget: jest.fn(() => OK),
  moveToTargetRoom: jest.fn(() => OK),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepDecision: (fn: () => unknown) => fn(),
  measureCreepIntent: (fn: () => unknown) => fn(),
}));

jest.mock("@/movement/traffic", () => ({ ...jest.requireActual("@/movement/traffic"),
  moveOffExit: jest.fn(() => OK),
}));

import { issueMove } from "@/movement/traffic";
import { healerRole } from "@/roles/healer";
import { clearCreepMovementStateForTest } from "@/movement/creepState";
import { createMockPowerBankCreep } from "@mock/powerBank";

const { moveToTarget } = jest.requireMock("@/roles/shared") as {
  moveToTarget: jest.Mock;
  moveToTargetRoom: jest.Mock;
};
const TARGET_ROOM = "E3N57";
const ATTACKER_CONFIG = "E1N57:war:E3N57:meleeAttacker:0";
const HEALER_CONFIG = "E1N57:war:E3N57:healer:0";


function hostileStructure(type: StructureConstant, id: string, x: number, y: number, hits = 3000): Structure {
  return {
    id: id as Id<Structure>,
    structureType: type,
    hits,
    hitsMax: hits,
    pos: { x, y, roomName: TARGET_ROOM, getRangeTo: jest.fn(() => 1) } as unknown as RoomPosition,
  } as Structure;
}


describe("healerRole war duo staging", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearCreepMovementStateForTest();
    Game.creeps = {};
    Game.getObjectById = jest.fn(() => null) as typeof Game.getObjectById;
  });

  it("does not restore partner identity from fallback args after owner detach", () => {
    const healer = createMockPowerBankCreep("healer", {
      name: "detached-healer",
      roomName: "E2N57",
      memory: {
        role: "healer",
        _warDetached: true,
      },
    });
    Game.creeps = { [healer.name]: healer };

    healerRole(TARGET_ROOM, "", "", "", ATTACKER_CONFIG).source?.(healer);

    expect(healer.memory._warPartnerConfigName).toBeUndefined();
  });

  it("steps into the attacker's previous tile when the paired attacker moves this tick", () => {
    const spawn = hostileStructure(STRUCTURE_SPAWN, "spawn-following-move", 23, 20, 5000);
    const attacker = createMockPowerBankCreep("meleeAttacker", {
      name: "attacker",
      roomName: TARGET_ROOM,
      x: 20,
      y: 20,
      memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG },
    });
    attacker.room.find = jest.fn((type: FindConstant) =>
      type === FIND_HOSTILE_STRUCTURES ? [spawn] : []
    ) as Room["find"];
    const healer = createMockPowerBankCreep("healer", {
      name: "healer",
      roomName: TARGET_ROOM,
      x: 19,
      y: 19,
      memory: { role: "healer", configName: HEALER_CONFIG },
    });
    Game.creeps = { attacker, healer };
    (attacker.memory as CreepMemory & { _warMoveIntentAt?: number })._warMoveIntentAt = Game.time;

    issueMove(attacker, RIGHT);
    healerRole(TARGET_ROOM, "", "", "", ATTACKER_CONFIG).target(healer);

    expect(healer.move).toHaveBeenCalledWith(healer.pos.getDirectionTo(attacker.pos));
    expect(moveToTarget).not.toHaveBeenCalled();
  });

  it.each(["marker_only", "destination_near", "destination_occupied"])("%s 不触发盲目跟随或覆盖通用让路", (kind) => {
    Game.time++;
    const attacker = createMockPowerBankCreep("meleeAttacker", { name: "red", roomName: TARGET_ROOM, x: 20, y: 20, memory: { role: "meleeAttacker", configName: ATTACKER_CONFIG, _warMoveIntentAt: Game.time } });
    const healer = createMockPowerBankCreep("healer", { name: "green", roomName: TARGET_ROOM, x: 19, y: kind === "destination_occupied" ? 20 : 19, memory: { role: "healer", configName: HEALER_CONFIG } });
    attacker.room.find = jest.fn(() => []) as Room["find"]; healer.room = attacker.room;
    Game.creeps = { red: attacker, green: healer };
    if (kind !== "marker_only") issueMove(attacker, LEFT);
    healerRole(TARGET_ROOM, "", "", "", ATTACKER_CONFIG).target(healer);
    expect(healer.move).not.toHaveBeenCalled();
  });
});
