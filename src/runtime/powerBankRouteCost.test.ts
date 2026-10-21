import { expandPowerBankCorridor, findPowerBankCostedRoute, getPowerBankRouteRoomCost, isPowerBankKeeperRoom } from "@/runtime/powerBankRouteCost";

describe("PB 走廊真实代价", () => {
  beforeEach(() => {
    Game.time = 1_000;
    Game.rooms = {};
  });

  it("高速/己方 1、普通 2、SK 5、避让 Infinity", () => {
    Game.rooms.E2N57 = { name: "E2N57", controller: { my: true } } as unknown as Room;
    const avoid = new Set(["E3N57"]);
    expect(getPowerBankRouteRoomCost("E0N57", avoid)).toBe(1);
    expect(getPowerBankRouteRoomCost("E2N57", avoid)).toBe(1);
    expect(getPowerBankRouteRoomCost("E1N57", avoid)).toBe(2);
    expect(getPowerBankRouteRoomCost("E4N54", avoid)).toBe(5);
    expect(getPowerBankRouteRoomCost("E5N55", avoid)).toBe(2);
    expect(getPowerBankRouteRoomCost("E3N57", avoid)).toBe(Infinity);
    expect(isPowerBankKeeperRoom("W6S4")).toBe(true);
    expect(isPowerBankKeeperRoom("W7S4")).toBe(false);
  });

  it("findRoute 使用代价回调并返回含起终点的房间序列", () => {
    let callback: ((room: string, from: string) => number) | undefined;
    Game.map = { ...Game.map, findRoute: jest.fn((_from: string, _to: string, options: { routeCallback: typeof callback }) => {
      callback = options.routeCallback;
      return [{ room: "E1N58", exit: FIND_EXIT_TOP }, { room: "E0N58", exit: FIND_EXIT_LEFT }];
    }) } as unknown as GameMap;
    expect(findPowerBankCostedRoute("E1N57", "E0N58", new Set(["E2N57"]))).toEqual(["E1N57", "E1N58", "E0N58"]);
    expect(callback!("E2N57", "E1N57")).toBe(Infinity);
    expect(callback!("E1N58", "E1N57")).toBe(2);
    expect(callback!("E0N58", "E1N58")).toBe(1);
  });

  it("走廊外扩一圈邻房，排除避让、敌方有主与 closed 房", () => {
    Game.rooms.W1N2 = { name: "W1N2", controller: { my: false, owner: { username: "enemy" } } } as unknown as Room;
    Game.map = {
      ...Game.map,
      describeExits: jest.fn((room: string) => room === "W1N1"
        ? { 1: "W1N2", 3: "W0N1", 5: "W1N0", 7: "W2N1" }
        : { 1: "W0N2", 7: "W1N1" }),
      getRoomStatus: jest.fn((room: string) => ({ status: room === "W0N2" ? "closed" : "normal", timestamp: null })),
    } as unknown as GameMap;
    expect(expandPowerBankCorridor(["W1N1", "W0N1"], new Set(["W2N1"]))).toEqual(["W1N1", "W0N1", "W1N0"]);
  });
});
