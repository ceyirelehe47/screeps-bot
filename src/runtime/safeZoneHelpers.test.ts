jest.mock("@/runtime/defenseMode", () => ({
  isDefenseMode: jest.fn(() => false),
  isOffensiveWarCreep: jest.fn(() => false),
}));

jest.mock("@/runtime/safeZone", () => ({
  getSafeZone: jest.fn(() => new Set()),
}));

import { isDefenseMode, isOffensiveWarCreep } from "@/runtime/defenseMode";
import { getSafeZone } from "@/runtime/safeZone";
import { isPositionAllowedForCreep, shouldRestrictToSafeZone } from "@/runtime/safeZoneHelpers";

function makeCreep(role: CreepMemory["role"], configName = "W1N1:test:0"): Creep {
  return {
    name: `${role}-1`,
    memory: { role, configName } as CreepMemory,
    room: { name: "W1N1" } as Room,
  } as Creep;
}

function makePos(x: number, y: number, roomName: string): RoomPosition {
  return { x, y, roomName } as RoomPosition;
}

describe("safeZoneHelpers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (isDefenseMode as jest.Mock).mockReturnValue(false);
    (isOffensiveWarCreep as jest.Mock).mockReturnValue(false);
    (getSafeZone as jest.Mock).mockReturnValue(new Set());
  });

  it("allows offensive war creeps to bypass restrictions", () => {
    const creep = makeCreep("meleeAttacker");
    (isDefenseMode as jest.Mock).mockReturnValue(true);
    (isOffensiveWarCreep as jest.Mock).mockReturnValue(true);
    (getSafeZone as jest.Mock).mockReturnValue(new Set([10 * 50 + 10]));

    expect(shouldRestrictToSafeZone(creep)).toBe(false);
  });

  it.each(["remoteCarrier", "colonizerHarvester", "powerBankHauler", "depositHarvester", "meleeAttacker"] as CreepMemory["role"][])("老家防御时外房 %s 仍能移动回家", role => {
    const creep = makeCreep(role);
    creep.room = { name: "W2N2" } as Room;
    (isDefenseMode as jest.Mock).mockReturnValue(true);
    expect(shouldRestrictToSafeZone(creep)).toBe(false);
    expect(isPositionAllowedForCreep(creep, makePos(10, 10, "W2N2"))).toBe(true);
  });

  it("rejects cross-room positions for restricted creeps", () => {
    const creep = makeCreep("worker");
    (isDefenseMode as jest.Mock).mockReturnValue(true);
    (getSafeZone as jest.Mock).mockReturnValue(new Set([10 * 50 + 10]));

    expect(isPositionAllowedForCreep(creep, makePos(10, 10, "W2N2"))).toBe(false);
  });
});
