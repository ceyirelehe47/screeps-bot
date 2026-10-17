jest.mock("@/roles/optionalCombatBoosts", () => ({ prepareOptionalCombatBoost: jest.fn(() => false) }));
jest.mock("@/roles/energyTargets", () => ({
  pickupEnergyFromPreferredTarget: jest.fn(() => ({ picked: false, outOfRange: false })),
}));
jest.mock("@/roles/shared", () => ({ moveToTarget: jest.fn() }));

import { prepareOptionalCombatBoost } from "@/roles/optionalCombatBoosts";
import { pickupEnergyFromPreferredTarget } from "@/roles/energyTargets";
import { moveToTarget } from "@/roles/shared";
import { upgraderRole } from "@/roles/upgrader";
import { createMockStore } from "@mock/powerBank";

const mockedPrepareBoost = prepareOptionalCombatBoost as jest.MockedFunction<typeof prepareOptionalCombatBoost>;
const mockedPickupEnergy = pickupEnergyFromPreferredTarget as jest.MockedFunction<typeof pickupEnergyFromPreferredTarget>;
const mockedMoveToTarget = moveToTarget as jest.MockedFunction<typeof moveToTarget>;

function createPos(): RoomPosition {
  return { getRangeTo: jest.fn(() => 1) } as unknown as RoomPosition;
}

function createRoom(
  structures: Structure[] = [],
  level = 7,
  my = true,
  name = "E4N58",
  ticksToDowngrade = level === 8 ? 200_000 : 150_000,
): Room {
  const room = {
    name,
    find: jest.fn(() => structures),
  } as unknown as Room;
  const controller = {
    my,
    level,
    ticksToDowngrade,
    pos: createPos(),
    room,
  } as StructureController;
  room.controller = controller;
  return room;
}

function createCreep(room: Room, energy = 0): Creep {
  return {
    name: "upgrader0",
    room,
    pos: createPos(),
    store: createMockStore({ [RESOURCE_ENERGY]: energy }, 250),
    memory: { role: "upgrader", configName: "E4N58:upgrader:0" },
    withdraw: jest.fn(() => OK),
    upgradeController: jest.fn(() => OK),
  } as unknown as Creep;
}

describe("upgraderRole", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedPrepareBoost.mockReturnValue(false);
    Memory.data = {
      manualUpgraders: { E4N58: { createdAt: Game.time, updatedAt: Game.time } },
      creepConfigs: {
        "E4N58:upgrader:0": {
          role: "upgrader",
          args: ["E4N58", "upgrader:E4N58"],
          roomName: "E4N58",
        },
      },
    };
  });

  it("lets an ordinary low-level upgrader retire without preparing, sourcing, moving, or upgrading", () => {
    const room = createRoom([], 7);
    Game.rooms.E4N58 = room;
    const creep = createCreep(room, 100);

    expect(upgraderRole("E4N58", "upgrader:E4N58").prepare?.(creep)).toBe(true);
    expect(upgraderRole("E4N58", "upgrader:E4N58").source?.(creep)).toBe(false);
    expect(upgraderRole("E4N58", "upgrader:E4N58").target(creep)).toBe(false);
    expect(mockedPrepareBoost).not.toHaveBeenCalled();
    expect(mockedPickupEnergy).not.toHaveBeenCalled();
    expect(mockedMoveToTarget).not.toHaveBeenCalled();
    expect(creep.withdraw).not.toHaveBeenCalled();
    expect(creep.upgradeController).not.toHaveBeenCalled();
  });

  it("stops an RCL8 maintenance creep at the recovery stop threshold", () => {
    const room = createRoom([], 8, true, "E4N58", 195_000);
    Game.rooms.E4N58 = room;
    Memory.data!.manualUpgraders!.E4N58.maintenance = true;
    Memory.data!.creepConfigs!["E4N58:upgrader:0"].args = ["E4N58"];
    const creep = createCreep(room, 100);

    expect(upgraderRole("E4N58").prepare?.(creep)).toBe(true);
    expect(upgraderRole("E4N58").target(creep)).toBe(false);
    expect(creep.upgradeController).not.toHaveBeenCalled();
  });
});
