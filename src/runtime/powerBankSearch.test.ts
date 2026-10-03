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
});
