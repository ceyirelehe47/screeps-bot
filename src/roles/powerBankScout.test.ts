jest.mock("@/roles/shared", () => ({
  moveToTargetRoom: jest.fn(() => OK),
}));

jest.mock("@/runtime/powerBankDiscovery", () => ({
  recordPowerBankDiscovery: jest.fn(),
}));

import { powerBankScoutRole, getActiveTransitDangerRooms } from "@/roles/powerBankScout";
import { isPowerBankSearchRoom } from "@/runtime/powerBankConstants";
import * as powerBankSearch from "@/runtime/powerBankSearch";

const { moveToTargetRoom } = jest.requireMock("@/roles/shared") as {
  moveToTargetRoom: jest.Mock;
};

class MockRoomPosition {
  constructor(
    public x: number,
    public y: number,
    public roomName: string,
  ) {}
}

function createMockCreep(roomName: string, memory: any = {}, hits = 1000, hitsMax = 1000): Creep {
  return {
    room: {
      name: roomName,
      find: jest.fn((constant: number) => {
        if (constant === FIND_STRUCTURES) return [];
        if (constant === FIND_HOSTILE_CREEPS) return [];
        if (constant === FIND_HOSTILE_POWER_CREEPS) return [];
        return [];
      }),
      controller: undefined,
    },
    memory: { ...memory },
    pos: new MockRoomPosition(25, 25, roomName) as unknown as RoomPosition,
    hits,
    hitsMax,
  } as unknown as Creep;
}

describe("powerBankScoutRole", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    Memory.runtime = {};
    Memory.data = {};
    Game.map = {
      ...Game.map,
      getWorldSize: jest.fn(() => 202),
      getRoomStatus: jest.fn(() => ({ status: "normal" as const, timestamp: null })),
    } as unknown as GameMap;
    Object.assign(global, {
      RoomPosition: MockRoomPosition,
    });
  });

  it("使用来源位置生成高速房，不依赖固定巡逻名单", () => {
    const creep = createMockCreep("E5N55");

    powerBankScoutRole().source?.(creep);

    expect(moveToTargetRoom).toHaveBeenCalledWith(creep, expect.any(String), undefined,
      expect.objectContaining({ plainCost: 1, swampCost: 1 }));
    expect(isPowerBankSearchRoom(moveToTargetRoom.mock.calls[0][1])).toBe(true);
    expect(moveToTargetRoom.mock.calls[0][1]).not.toBe("E0N60");
  });

  it("跨房移动不会把搜索来源改成当前位置", () => {
    const creep = createMockCreep("E5N55");
    powerBankScoutRole().source?.(creep);
    const target = moveToTargetRoom.mock.calls[0][1];
    creep.room = createMockCreep("E6N55").room;
    powerBankScoutRole().source?.(creep);
    expect(moveToTargetRoom.mock.calls[1][1]).toBe(target);
  });

  it("补盲使用所有来源周边的并集", () => {
    const search = jest.spyOn(powerBankSearch, "getPowerBankSearchRooms")
      .mockImplementation((origin) => origin ? ["E0N60"] : ["E40N40"]);
    const creep = createMockCreep("E5N55");
    powerBankScoutRole().source?.(creep);
    expect(moveToTargetRoom).toHaveBeenCalledWith(creep, "E40N40", undefined, expect.any(Object));
    expect(search).toHaveBeenCalledWith();
  });

  describe("getActiveTransitDangerRooms", () => {

    it("retains permanent danger while cleaning expired temporary danger", () => {
      Memory.runtime = Memory.runtime || {} as any;
      Memory.runtime.transitDangerRooms = { E2N54: Game.time - 1 };
      (Memory.runtime as any).powerBankPermanentDangerRooms = { E3N57: true };

      const rooms = getActiveTransitDangerRooms();

      expect(rooms).toEqual(["E3N57"]);
      expect(Memory.runtime!.transitDangerRooms!["E2N54"]).toBeUndefined();
      expect((Memory.runtime as any).powerBankPermanentDangerRooms?.E3N57).toBe(true);
    });

    it("高速搜索房不豁免仍有效的危险记录", () => {
      Memory.runtime!.transitDangerRooms = { E0N60: Game.time + 100 };
      expect(getActiveTransitDangerRooms()).toContain("E0N60");
      expect(Memory.runtime!.transitDangerRooms.E0N60).toBe(Game.time + 100);
    });
  });
});
