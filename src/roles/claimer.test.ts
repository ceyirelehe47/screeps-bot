jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(),
  moveToTargetRoom: jest.fn(),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepIntent: jest.fn((fn: () => number) => fn()),
}));

import { claimerRole } from "@/roles/claimer";
import { moveToTarget } from "@/roles/shared";

function createRoom(): Room {
  return {
    name: "W9N9",
    controller: {
      my: false,
      reservation: {
        username: "Invader",
      },
    } as StructureController,
  } as Room;
}

function createCreep(room: Room): Creep {
  return {
    room,
    claimController: jest.fn(),
    attackController: jest.fn(),
  } as unknown as Creep;
}

describe("claimerRole", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("attacks a hostile reservation when claimController returns invalid target", () => {
    const room = createRoom();
    const creep = createCreep(room);
    creep.claimController = jest.fn(() => ERR_INVALID_TARGET);
    creep.attackController = jest.fn(() => ERR_NOT_IN_RANGE);

    const role = claimerRole(room.name);
    role.target(creep);

    expect(creep.claimController).toHaveBeenCalledWith(room.controller);
    expect(creep.attackController).toHaveBeenCalledWith(room.controller);
    expect(moveToTarget).toHaveBeenCalledWith(creep, room.controller, 1, { plainCost: 2, swampCost: 8, maxRooms: 1 });
  });

  it("uses single-room controller pathing when claim is out of range", () => {
    const room = createRoom();
    const creep = createCreep(room);
    creep.claimController = jest.fn(() => ERR_NOT_IN_RANGE);

    const role = claimerRole(room.name);
    role.target(creep);

    expect(moveToTarget).toHaveBeenCalledWith(creep, room.controller, 1, { plainCost: 2, swampCost: 8, maxRooms: 1 });
  });
});


it("原生 GCL 失败写入 500 tick 冷却，避免失效摘要导致反复重派", () => {
  const room = createRoom(), creep = createCreep(room);
  Game.time = 2000;
  Memory.data = { colonization: { W9N9: { targetRoom: "W9N9", sourceRoom: "W1N1", flagName: "CL", status: "claiming",
    planReady: false, claimCompleted: false, createdAt: 1, updatedAt: 1 } } };
  creep.claimController = jest.fn(() => ERR_GCL_NOT_ENOUGH);
  claimerRole(room.name).target(creep);
  expect(Memory.data!.colonization!.W9N9).toMatchObject({ blockedReason: "gcl_not_enough", blockedUntil: 2500 });
  expect(creep.attackController).not.toHaveBeenCalled();
});
