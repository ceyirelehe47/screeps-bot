import { isPowerBankSearchRoom } from "@/runtime/powerBankConstants";
import { getPowerBankSearchRooms } from "@/runtime/powerBankSearch";

describe("PowerBank 动态搜房", () => {
  beforeEach(() => {
    Game.map = {
      ...Game.map,
      getWorldSize: jest.fn(() => 202),
      getRoomStatus: jest.fn(() => ({ status: "normal" as const, timestamp: null })),
    } as unknown as GameMap;
  });

  it.each(["E20N7", "W3S10", "W0N0", "E0S1"])("识别任意高速房 %s", (roomName) => {
    expect(isPowerBankSearchRoom(roomName)).toBe(true);
  });

  it.each(["E3N59", "sim", "E01N60", "E9007199254740992N0"])("拒绝非高速或非法房名 %s", (roomName) => {
    expect(isPowerBankSearchRoom(roomName)).toBe(false);
  });

  it("跨零坐标按世界坐标计算观察半径", () => {
    const rooms = getPowerBankSearchRooms("E0S0");
    expect(rooms).toEqual(expect.arrayContaining(["W0N0", "W9N0", "E10S0", "E0S10"]));
    expect(rooms).not.toContain("W10N0");
    expect(rooms).not.toContain("E11S0");
    expect(rooms).not.toContain("E0N10");
    expect(new Set(rooms).size).toBe(rooms.length);
  });

  it("排除封闭房与世界边界之外的房间", () => {
    Game.map.getRoomStatus = jest.fn((name: string) => ({ status: name === "E100S100" ? "closed" as const : "normal" as const, timestamp: null }));
    const rooms = getPowerBankSearchRooms("E100S100");
    expect(rooms).not.toContain("E100S100");
    expect(rooms).not.toContain("E110S100");
    expect(rooms).not.toContain("E100S110");
    expect(rooms).toContain("E100S99");
  });

  it("不让极大房名坐标导致非递增循环", () => {
    expect(getPowerBankSearchRooms("E9007199254740991S0")).toEqual([]);
    expect(getPowerBankSearchRooms("sim")).toEqual([]);
  });

  it("同 tick 重复读取不重扫房间状态，返回数组修改不污染 memo", () => {
    const first = getPowerBankSearchRooms("E0S0");
    const expected = [...first];
    const status = Game.map.getRoomStatus as jest.Mock;
    const coldReads = status.mock.calls.length;
    expect(coldReads).toBe(expected.length);
    expect(coldReads).toBeGreaterThan(0);
    first.splice(0, first.length, "caller-only");

    const second = getPowerBankSearchRooms("E0S0");
    expect(second).toEqual(expected);
    second.pop();
    for (let index = 0; index < 10; index += 1) {
      expect(getPowerBankSearchRooms("E0S0")).toEqual(expected);
    }
    expect(status).toHaveBeenCalledTimes(coldReads);
  });

  it("同 tick 的 origin 和世界边界变化分别失效", () => {
    const status = Game.map.getRoomStatus as jest.Mock;
    getPowerBankSearchRooms("E0S0");
    const firstReads = status.mock.calls.length;
    expect(getPowerBankSearchRooms("E20S20")).toContain("E20S20");
    expect(status.mock.calls.length).toBeGreaterThan(firstReads);

    (Game.map.getWorldSize as jest.Mock).mockReturnValue(20);
    const clipped = getPowerBankSearchRooms("E0S0");
    expect(clipped).not.toContain("E10S0");
    expect(clipped).toContain("E0S0");
  });

  it("同 tick 的来源成员、RCL 与归属变化更新 union 输入", () => {
    const near = { name: "E3S3", controller: { my: true, level: 6 } } as unknown as Room;
    const remoteController = { my: true, level: 5 };
    const remote = { name: "E43S43", controller: remoteController } as unknown as Room;
    Game.rooms = { [near.name]: near, [remote.name]: remote };
    expect(getPowerBankSearchRooms()).not.toContain("E40S40");

    remoteController.level = 6;
    expect(getPowerBankSearchRooms()).toContain("E40S40");
    remoteController.my = false;
    expect(getPowerBankSearchRooms()).not.toContain("E40S40");
    remoteController.my = true;
    delete Game.rooms[near.name];
    const remoteOnly = getPowerBankSearchRooms();
    expect(remoteOnly).toContain("E40S40");
    expect(remoteOnly).not.toContain("E0S0");
  });

  it("同 tick 换 Game 身份必须重扫，即使其余输入和 map 相同", () => {
    const originalGame = Game;
    const status = Game.map.getRoomStatus as jest.Mock;
    getPowerBankSearchRooms("E0S0");
    const coldReads = status.mock.calls.length;
    const runtimeGlobal = global as unknown as { Game: Game };
    try {
      runtimeGlobal.Game = { ...originalGame } as Game;
      expect(getPowerBankSearchRooms("E0S0")).toContain("E0S0");
      expect(status).toHaveBeenCalledTimes(coldReads * 2);
    } finally {
      runtimeGlobal.Game = originalGame;
    }
  });

  it("跨 tick 重新读取状态，不能沿用上 tick 的开放房间", () => {
    const status = Game.map.getRoomStatus as jest.Mock;
    const first = getPowerBankSearchRooms("E0S0");
    const coldReads = status.mock.calls.length;
    expect(first).toContain("E0S0");
    status.mockImplementation((name: string) => ({ status: name === "E0S0" ? "closed" : "normal", timestamp: null }));
    Game.time += 1;

    expect(getPowerBankSearchRooms("E0S0")).not.toContain("E0S0");
    expect(status).toHaveBeenCalledTimes(coldReads * 2);
  });
});
