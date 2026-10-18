jest.mock("@/roles/shared", () => ({
  getCurrentScoutRoute: jest.fn(() => undefined),
  moveToTargetRoom: jest.fn(() => OK),
}));

import { scoutRole } from "@/roles/scout";

const {
  getCurrentScoutRoute,
  moveToTargetRoom,
} = jest.requireMock("@/roles/shared") as {
  getCurrentScoutRoute: jest.Mock;
  moveToTargetRoom: jest.Mock;
};

class MockRoomPosition {
  constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}
}

describe("scoutRole", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getCurrentScoutRoute.mockReturnValue(undefined);
    Object.assign(global, {
      RoomPosition: MockRoomPosition,
    });
  });

  it("keeps using fixed room routing when a scout route is available", () => {
    const creep = {
      room: { name: "W1N1" },
      memory: {},
      pos: {},
      suicide: jest.fn(),
    } as unknown as Creep;
    getCurrentScoutRoute.mockReturnValue("W1N1|W1N2");

    scoutRole("W1N2").source?.(creep);

    expect(moveToTargetRoom).toHaveBeenCalledWith(creep, "W1N2", "W1N1|W1N2", {
      plainCost: 2,
      swampCost: 10,
      reusePath: 5,
      profile: "travel",
    });
  });

  describe("suspended remote mining keep-alive", () => {

    it("stays alive to preserve vision during Invader Core clearance", () => {
      const creep = {
        room: { name: "W2N57" },
        memory: {},
        pos: { x: 25, y: 25, roomName: "W2N57" },
        suicide: jest.fn(),
      } as unknown as Creep;

      Memory.data = {
        remoteMining: {
          "W2N57": {
            sourceRoom: "W1N57",
            targetRoom: "W2N57",
            status: "defending",
            sourceIds: ["source-0", "source-1"],
            assignedAt: 50,
            updatedAt: 100,
            defenseReason: "npc_invader_core",
          } satisfies import("@/runtime/remoteMining").RemoteMiningTask,
        },
      };

      scoutRole("W2N57").source?.(creep);

      expect(creep.suicide).not.toHaveBeenCalled();
      expect(moveToTargetRoom).not.toHaveBeenCalled();
    });
  });
});
