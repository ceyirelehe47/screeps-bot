jest.mock("@/roles/shared", () => ({
  moveToTarget: jest.fn(),
  moveToTargetRoom: jest.fn(),
}));

jest.mock("@/runtime/cpuPhaseProfiler", () => ({
  measureCreepIntent: jest.fn((fn: () => number) => fn()),
}));

import { claimerRole } from "@/roles/claimer";
import { crossShardClaimerRole } from "@/roles/crossShardClaimer";
import { moveToTarget, moveToTargetRoom } from "@/roles/shared";

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

  it.each(["claim", "attack", "crossShard"])("工作中的 %s 被挤出目标后重新旅行，只在指定房间操作控制器", mode => {
    const creep = createCreep(createRoom());
    const nextRoom = "W8N9";
    Game.shard = { name: "shard1", type: "normal", ptr: false };
    const role = mode === "crossShard"
      ? crossShardClaimerRole("other-shard", creep.room.name, nextRoom)
      : claimerRole(nextRoom, undefined, mode);
    expect(role.target(creep)).toBe(true);
    expect(creep.claimController).not.toHaveBeenCalled();
    expect(creep.attackController).not.toHaveBeenCalled();
    role.source!(creep);
    expect(moveToTargetRoom).toHaveBeenCalledWith(creep, nextRoom, undefined, expect.anything());
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
