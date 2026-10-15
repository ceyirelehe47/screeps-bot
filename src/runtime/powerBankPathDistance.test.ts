import type { PowerBankTierProfile } from "@/runtime/powerBankViability";
import type { PowerBankTravelMeasurementInput } from "@/runtime/powerBankPathDistance";

jest.mock("@/movement/routing", () => ({ getCachedStaticTravelMatrix: jest.fn() }));
jest.mock("@/movement/roomTopologyRevision", () => ({ getRoomTopologyRevision: jest.fn(() => "stable") }));
jest.mock("@/runtime/runtimeServices", () => ({
  getTickContextService: () => ({ getRoomContext: () => null }),
}));

class TestCostMatrix {
  private cells = new Map<string, number>();
  get(x: number, y: number): number { return this.cells.get(`${x}:${y}`) ?? 0; }
  set(x: number, y: number, value: number): void { this.cells.set(`${x}:${y}`, value); }
  clone(): TestCostMatrix {
    const cloned = new TestCostMatrix();
    cloned.cells = new Map(this.cells);
    return cloned;
  }
}

function pos(x: number, y = 10, roomName = "W1N1"): RoomPosition {
  return { x, y, roomName } as RoomPosition;
}

function visibleRoom(name: string, structures: Structure[] = []): Room {
  return {
    name,
    find: jest.fn((type: FindConstant) => type === FIND_STRUCTURES ? structures : []),
  } as unknown as Room;
}

function profile(): PowerBankTierProfile {
  return {
    tier: 6,
    attacker: { body: [ATTACK, MOVE] },
    healer: { body: [HEAL, MOVE] },
  } as unknown as PowerBankTierProfile;
}

function input(): PowerBankTravelMeasurementInput {
  return {
    sourceSpawnPos: pos(10),
    bankPos: pos(13),
    returnTargetPos: pos(9),
    routeRooms: ["W1N1"],
    avoidRooms: [],
    profile: profile(),
    haulerCarryParts: 10,
  };
}

function straightSameRoom(origin: RoomPosition, goal: { pos: RoomPosition; range: number }): PathFinderPath {
  const path: RoomPosition[] = [];
  let x = origin.x;
  let y = origin.y;
  while (Math.max(Math.abs(x - goal.pos.x), Math.abs(y - goal.pos.y)) > goal.range) {
    x += Math.sign(goal.pos.x - x);
    y += Math.sign(goal.pos.y - y);
    path.push(pos(x, y, origin.roomName));
  }
  return { path, incomplete: false, ops: 100, cost: 99_999 };
}

const boundaryCases: Array<[
  string, string, RoomPosition, RoomPosition, RoomPosition, RoomPosition[], RoomPosition[],
]> = [
  ["W0N0", "E0N0", pos(49, 10, "W0N0"), pos(2, 10, "E0N0"), pos(48, 10, "W0N0"),
    [pos(0, 10, "E0N0"), pos(1, 10, "E0N0")], [pos(0, 10, "E0N0"), pos(49, 10, "W0N0")]],
  ["E0N0", "E0S0", pos(10, 49, "E0N0"), pos(10, 2, "E0S0"), pos(10, 48, "E0N0"),
    [pos(10, 0, "E0S0"), pos(10, 1, "E0S0")], [pos(10, 0, "E0S0"), pos(10, 49, "E0N0")]],
];

describe("Power Bank 静态完整路径测量", () => {
  let measure: typeof import("@/runtime/powerBankPathDistance").measurePowerBankTravel;
  let canMeasure: typeof import("@/runtime/powerBankPathDistance").canMeasurePowerBankTravelThisTick;
  let search: jest.Mock;
  let staticMatrix: TestCostMatrix;
  let topology: jest.Mock;

  beforeEach(() => {
    jest.resetModules();
    Game.time = 1_000;
    Game.cpu = { ...Game.cpu, limit: 120, tickLimit: 500, bucket: 10000, getUsed: jest.fn(() => 0) };
    Game.rooms = { W1N1: visibleRoom("W1N1") };
    Game.map = {
      ...Game.map,
      getRoomStatus: jest.fn(() => ({ status: "normal", timestamp: null })),
      getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) })),
    } as unknown as GameMap;
    search = jest.fn(straightSameRoom);
    Object.assign(global, { PathFinder: { CostMatrix: TestCostMatrix, search } });
    staticMatrix = new TestCostMatrix();
    const routing = jest.requireMock("@/movement/routing") as { getCachedStaticTravelMatrix: jest.Mock };
    routing.getCachedStaticTravelMatrix.mockReturnValue(staticMatrix);
    topology = (jest.requireMock("@/movement/roomTopologyRevision") as { getRoomTopologyRevision: jest.Mock })
      .getRoomTopologyRevision;
    const module = require("@/runtime/powerBankPathDistance") as typeof import("@/runtime/powerBankPathDistance");
    measure = module.measurePowerBankTravel;
    canMeasure = module.canMeasurePowerBankTravelThisTick;
  });

  it("CPU 忙时不搜索、不消费名额，恢复后同 tick 能完成测路", () => {
    jest.mocked(Game.cpu.getUsed).mockReturnValue(200);
    expect(measure(input())).toMatchObject({ status: "pending", reason: "budget" });
    expect(search).not.toHaveBeenCalled();
    expect(canMeasure()).toBe(true);
    jest.mocked(Game.cpu.getUsed).mockReturnValue(80);
    expect(measure(input())).toMatchObject({ status: "ready" });
    expect(search).toHaveBeenCalledTimes(3);
  });

  it("CPU 忙时仍可读取已经验证的完整路径，不重做搜索", () => {
    expect(measure(input())).toMatchObject({ status: "ready" });
    Game.time += 1;
    search.mockClear();
    jest.mocked(Game.cpu.getUsed).mockReturnValue(200);
    expect(measure(input())).toMatchObject({ status: "ready" });
    expect(search).not.toHaveBeenCalled();
  });

  it("三段独立搜索使用实际空车末点返程，时间来自负重地形而非 PF cost", () => {
    (Game.map.getRoomTerrain as jest.Mock).mockReturnValue({
      get: (x: number) => x === 11 ? TERRAIN_MASK_SWAMP : 0,
    });
    const candidate = input();
    candidate.profile = {
      ...candidate.profile,
      attacker: { ...candidate.profile.attacker, body: [ATTACK, TOUGH, TOUGH, MOVE] },
    };

    expect(measure(candidate)).toEqual({
      status: "ready", pathDistance: 2, combatTravelTicks: 18,
      haulerOutboundTravelTicks: 2, haulerReturnTravelTicks: 6,
    });
    expect(search).toHaveBeenCalledTimes(3);
    expect(search.mock.calls[0][1]).toEqual({ pos: candidate.bankPos, range: 1 });
    expect(search.mock.calls[0][2]).toMatchObject({ plainCost: 2, swampCost: 8, maxOps: 6_000, maxRooms: 1 });
    expect(search.mock.calls[1][2]).toMatchObject({ plainCost: 1, swampCost: 1 });
    expect(search.mock.calls[2][0]).toEqual(pos(12));
    expect(search.mock.calls[2][1]).toEqual({ pos: candidate.returnTargetPos, range: 1 });
    expect(search.mock.calls[2][2]).toMatchObject({ plainCost: 1, swampCost: 5 });
  });

  it("只有已建 road 降低沼泽疲劳；road 工地的矩阵偏好不冒充已建道路", () => {
    (Game.map.getRoomTerrain as jest.Mock).mockReturnValue({ get: () => TERRAIN_MASK_SWAMP });
    staticMatrix.set(11, 10, 1);
    expect(measure(input())).toMatchObject({ combatTravelTicks: 10, haulerReturnTravelTicks: 10 });

    Game.time += 1;
    Game.rooms.W1N1 = visibleRoom("W1N1", [{ structureType: STRUCTURE_ROAD, pos: pos(11) } as Structure]);
    topology.mockReturnValue("road-built");
    expect(measure(input())).toMatchObject({ combatTravelTicks: 6, haulerReturnTravelTicks: 6 });
  });

  it("多个模块与 Spawn 共用原生房间状态，地形疲劳与三段完整计时保持独立", () => {
    const terrain = { get: jest.fn((x: number) => x === 11 ? TERRAIN_MASK_SWAMP : 0) };
    (Game.map.getRoomTerrain as jest.Mock).mockReturnValue(terrain);
    const candidate = input();
    candidate.profile = {
      ...candidate.profile,
      attacker: { ...candidate.profile.attacker, body: [ATTACK, TOUGH, TOUGH, MOVE] },
    };
    search.mockImplementation((origin: RoomPosition, goal: { pos: RoomPosition; range: number }, options: PathFinderOpts) => {
      expect(options.roomCallback?.(origin.roomName)).not.toBe(false);
      return straightSameRoom(origin, goal);
    });
    Game.map.getWorldSize = () => 202;
    Game.map.describeExits = jest.fn(() => ({ [RIGHT]: "W1N2" })) as GameMap["describeExits"];
    const { getPowerBankAdmissionRoute } = require("@/runtime/powerBankRouteCache") as typeof import("@/runtime/powerBankRouteCache");
    const corridor = ["W1N1", "W1N2"];
    const readRoute = () => getPowerBankAdmissionRoute(corridor[0], corridor[1], [], () => [...corridor]);
    expect(readRoute()).toEqual(corridor);

    expect(measure(candidate)).toEqual({
      status: "ready", pathDistance: 2, combatTravelTicks: 18,
      haulerOutboundTravelTicks: 2, haulerReturnTravelTicks: 6,
    });
    expect(search).toHaveBeenCalledTimes(3);
    expect(Game.map.getRoomStatus).toHaveBeenCalledTimes(2);
    expect(Game.map.getRoomTerrain).toHaveBeenCalledTimes(1);
    expect(Game.rooms.W1N1.find).toHaveBeenCalledTimes(1);
    expect(terrain.get.mock.calls).toEqual([[11, 10], [12, 10], [10, 10]]);

    // 新 tick 只重读每房一次；旧 ready 不消费名额，另一 Spawn 继续独立测量。
    Game.time += 1;
    (Game.map.getRoomStatus as jest.Mock).mockClear();
    expect(readRoute()).toEqual(corridor);
    expect(measure(candidate).status).toBe("ready");
    expect(measure({ ...candidate, sourceSpawnPos: pos(9) }).status).toBe("ready");
    expect(Game.map.getRoomStatus).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenCalledTimes(6);
  });

  it.each([
    ["incomplete partial", { path: [pos(11), pos(12)], incomplete: true, ops: 6_000, cost: 2 }],
    ["jump", { path: [pos(12)], incomplete: false, ops: 1, cost: 1 }],
    ["invalid coordinate", { path: [pos(50)], incomplete: false, ops: 1, cost: 1 }],
    ["fractional coordinate", { path: [pos(11.5)], incomplete: false, ops: 1, cost: 1 }],
    ["nonfinite coordinate", { path: [pos(NaN)], incomplete: false, ops: 1, cost: 1 }],
    ["invalid room", { path: [pos(11, 10, "bad-room")], incomplete: false, ops: 1, cost: 1 }],
    ["wrong goal", { path: [pos(11)], incomplete: false, ops: 1, cost: 1 }],
    ["false empty", { path: [], incomplete: false, ops: 1, cost: 0 }],
  ])("拒绝 %s，并对同输入短退避", (_name, result) => {
    search.mockReturnValue(result);
    expect(measure(input())).toEqual({ status: "pending", reason: "path_incomplete", retryAt: 1_005 });
    Game.time += 4;
    expect(measure(input())).toMatchObject({ status: "pending", retryAt: 1_005 });
    expect(search).toHaveBeenCalledTimes(1);
    Game.time += 1;
    search.mockImplementation(straightSameRoom);
    expect(measure(input()).status).toBe("ready");
    expect(search).toHaveBeenCalledTimes(4);
  });

  it("三个搜索都需完整；返程 partial 不产生 ready", () => {
    search.mockImplementationOnce(straightSameRoom).mockImplementationOnce(straightSameRoom)
      .mockReturnValueOnce({ path: [pos(11)], incomplete: true, ops: 6_000, cost: 1 });
    expect(measure(input())).toMatchObject({ status: "pending", reason: "path_incomplete" });
    expect(search).toHaveBeenCalledTimes(3);
  });

  it("pending 退避跨中转房视野变化仍复用，让另一来源获得完整测量预算", () => {
    const origin = "W1N0", transit = "W0N0", target = "E0N0";
    Game.rooms = { W1N1: visibleRoom("W1N1"), [origin]: visibleRoom(origin), [target]: visibleRoom(target) };
    const candidate = {
      ...input(), sourceSpawnPos: pos(49, 10, origin), bankPos: pos(2, 10, target),
      returnTargetPos: pos(48, 10, origin), routeRooms: [origin, transit, target],
    };
    search.mockImplementation((source: RoomPosition, goal: { pos: RoomPosition; range: number }) => source.roomName === origin
      ? { path: [pos(0, 10, transit)], incomplete: true, ops: 6_000, cost: 1 }
      : straightSameRoom(source, goal));
    const deferred = measure(candidate);
    expect(deferred).toEqual({ status: "pending", reason: "path_incomplete", retryAt: 1_005 });
    expect(canMeasure()).toBe(false);

    Game.time += 1;
    Game.rooms[transit] = visibleRoom(transit);
    topology.mockReturnValue("transit-now-visible");
    topology.mockClear();
    (Game.map.getRoomStatus as jest.Mock).mockClear();
    expect(measure(candidate)).toBe(deferred);
    expect(topology).not.toHaveBeenCalled();
    expect(Game.map.getRoomStatus).not.toHaveBeenCalled();
    expect(canMeasure()).toBe(true);
    expect(measure(input()).status).toBe("ready");
    expect(search).toHaveBeenCalledTimes(4);

    Game.time += 1;
    delete Game.rooms[transit];
    topology.mockReturnValue("transit-lost-again");
    expect(measure(candidate)).toBe(deferred);
    expect(canMeasure()).toBe(true);
    expect(search).toHaveBeenCalledTimes(4);
    Game.time = 1_005;
    expect(measure(candidate)).toEqual({ status: "pending", reason: "path_incomplete", retryAt: 1_010 });
    expect(search).toHaveBeenCalledTimes(5);
  });

  it("pending 退避只复用完整输入 key，Bank 位置改变仍需新测量", () => {
    search.mockReturnValue({ path: [], incomplete: true, ops: 6_000, cost: 0 });
    expect(measure(input())).toMatchObject({ status: "pending", retryAt: 1_005 });
    Game.time += 1;
    search.mockImplementation(straightSameRoom);
    expect(measure({ ...input(), bankPos: pos(14) }).status).toBe("ready");
    expect(search).toHaveBeenCalledTimes(4);
    expect(canMeasure()).toBe(false);
  });

  it("pending 命中前仍要求有效输入与当前端点视野", () => {
    search.mockReturnValue({ path: [], incomplete: true, ops: 6_000, cost: 0 });
    const candidate = input();
    const deferred = measure(candidate);
    Game.time += 1;
    delete Game.rooms.W1N1;
    expect(measure(candidate)).toMatchObject({ status: "pending", reason: "endpoint_not_visible" });
    Game.rooms.W1N1 = visibleRoom("W1N1");
    expect(measure({ ...candidate, bankPos: pos(50) })).toMatchObject({ status: "pending", reason: "invalid_input" });
    expect(measure(candidate)).toBe(deferred);
    expect(search).toHaveBeenCalledTimes(1);
    expect(canMeasure()).toBe(true);
  });

  it("合法 range 1 内的零路径成立，并从实际 origin 做返程", () => {
    const candidate = { ...input(), bankPos: pos(11), returnTargetPos: pos(10) };
    expect(measure(candidate)).toEqual({
      status: "ready", pathDistance: 0, combatTravelTicks: 0,
      haulerOutboundTravelTicks: 0, haulerReturnTravelTicks: 0,
    });
    expect(search.mock.calls[2][0]).toBe(candidate.sourceSpawnPos);
  });

  it.each(boundaryCases)("跨零坐标 %s → %s 的路径连续性正确", (source, target, sourcePos, bankPos, returnPos, outbound, loadedReturn) => {
    Game.rooms = { [source]: visibleRoom(source), [target]: visibleRoom(target) };
    search.mockReturnValueOnce({ path: outbound, incomplete: false, cost: 2, ops: 1 })
      .mockReturnValueOnce({ path: outbound, incomplete: false, cost: 2, ops: 1 })
      .mockReturnValueOnce({ path: loadedReturn, incomplete: false, cost: 2, ops: 1 });
    expect(measure({ ...input(), sourceSpawnPos: sourcePos, bankPos, returnTargetPos: returnPos, routeRooms: [source, target] }))
      .toMatchObject({ status: "ready", pathDistance: 2 });
  });

  it("长路径跨西东零坐标，三段完整证据与逐步相邻检查保持一致", () => {
    const rooms = ["W1N0", "W0N0", "E0N0"];
    Game.rooms = Object.fromEntries(rooms.map(name => [name, visibleRoom(name)]));
    const candidate = {
      ...input(), sourceSpawnPos: pos(10, 10, rooms[0]), bankPos: pos(13, 10, rooms[2]),
      returnTargetPos: pos(9, 10, rooms[0]), routeRooms: rooms,
    };
    search.mockImplementation((origin: RoomPosition, goal: { pos: RoomPosition; range: number }) => {
      const worldX = (point: RoomPosition) => (point.roomName[0] === "W"
        ? -Number(point.roomName.slice(1).split("N")[0]) - 1
        : Number(point.roomName.slice(1).split("N")[0])) * 50 + point.x;
      let x = worldX(origin);
      const targetX = worldX(goal.pos);
      const path: RoomPosition[] = [];
      while (Math.abs(x - targetX) > 1) {
        x += Math.sign(targetX - x);
        const roomX = Math.floor(x / 50);
        path.push(pos(x - roomX * 50, 10, `${roomX < 0 ? `W${-roomX - 1}` : `E${roomX}`}N0`));
      }
      return { path, incomplete: false, ops: 100, cost: path.length };
    });
    expect(measure(candidate)).toEqual({
      status: "ready", pathDistance: 102, combatTravelTicks: 102,
      haulerOutboundTravelTicks: 102, haulerReturnTravelTicks: 102,
    });
    expect(search).toHaveBeenCalledTimes(3);
    // 原生地图事实复用不能让同 tick 新危险或所有权借旧 ready 放行。
    candidate.avoidRooms = [rooms[1]];
    expect(measure(candidate)).toMatchObject({ status: "pending", reason: "unsafe_route" });
    candidate.avoidRooms = [];
    Game.rooms[rooms[1]].controller = { my: false, owner: { username: "enemy" } } as StructureController;
    expect(measure(candidate)).toMatchObject({ status: "pending", reason: "unsafe_route" });
    delete Game.rooms[rooms[1]].controller;
    expect(measure(candidate).status).toBe("ready");
    expect(search).toHaveBeenCalledTimes(3);
    // 相同路线/端点仍不能把非相邻步当成完整证明。
    Game.time += 101;
    search.mockReturnValue({ path: [pos(12, 10, rooms[0])], incomplete: false, ops: 1, cost: 1 });
    expect(measure(candidate)).toMatchObject({ status: "pending", reason: "path_incomplete" });
  });

  it("目标在出口时，相邻房边缘末点不能冒充同房 range 1", () => {
    Game.rooms = { W0N0: visibleRoom("W0N0"), E0N0: visibleRoom("E0N0") };
    search.mockReturnValue({ path: [pos(49, 10, "W0N0")], incomplete: false, ops: 1, cost: 1 });
    expect(measure({
      ...input(), sourceSpawnPos: pos(48, 10, "W0N0"), bankPos: pos(0, 10, "E0N0"),
      returnTargetPos: pos(47, 10, "W0N0"), routeRooms: ["W0N0", "E0N0"],
    })).toMatchObject({ status: "pending", reason: "path_incomplete" });
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("每 tick 只测一个新输入，ready 命中不消耗下一 tick 的预算", () => {
    const first = input();
    const second = { ...input(), bankPos: pos(14) };
    expect(measure(first).status).toBe("ready");
    expect(measure(second)).toEqual({ status: "pending", reason: "budget", retryAt: 1_001 });
    expect(search).toHaveBeenCalledTimes(3);
    Game.time += 1;
    expect(measure(first).status).toBe("ready");
    expect(search).toHaveBeenCalledTimes(3);
    expect(measure(second).status).toBe("ready");
    expect(search).toHaveBeenCalledTimes(6);
  });

  it("预算查询不读地图、不耗配额，tick 与 Game 换代刷新配额", () => {
    expect(canMeasure()).toBe(true);
    expect(canMeasure()).toBe(true);
    expect(Game.map.getRoomStatus).not.toHaveBeenCalled();
    expect(topology).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(measure(input()).status).toBe("ready");
    expect(canMeasure()).toBe(false);
    Game.time += 1;
    expect(canMeasure()).toBe(true);
    expect(measure({ ...input(), bankPos: pos(14) }).status).toBe("ready");
    expect(canMeasure()).toBe(false);

    const previousGame = Game;
    Object.assign(global, { Game: { ...Game } });
    try {
      expect(canMeasure()).toBe(true);
      expect(measure({ ...input(), bankPos: pos(15) }).status).toBe("ready");
      expect(canMeasure()).toBe(false);
    } finally {
      Object.assign(global, { Game: previousGame });
    }
    expect(search).toHaveBeenCalledTimes(9);
  });

  it("预算耗尽仍对已缓存 ready 新读拓扑，变更后拒绝旧证据并等下一 tick", () => {
    const candidate = input();
    expect(measure(candidate).status).toBe("ready");
    expect(canMeasure()).toBe(false);
    topology.mockClear();
    (Game.map.getRoomStatus as jest.Mock).mockClear();
    topology.mockReturnValue("changed-after-ready");

    expect(measure(candidate)).toEqual({ status: "pending", reason: "budget", retryAt: 1_001 });
    expect(topology).toHaveBeenCalledTimes(1);
    // 同帧原始地图事实已取得，拓扑仍按调用方原合同重新核验。
    expect(Game.map.getRoomStatus).not.toHaveBeenCalled();
    expect(search).toHaveBeenCalledTimes(3);
    Game.time += 1;
    expect(measure(candidate).status).toBe("ready");
    expect(search).toHaveBeenCalledTimes(6);
  });

  it("超过 64 个未测预算候选不会驱逐已测 ready 证据", () => {
    const ready = input();
    expect(measure(ready).status).toBe("ready");
    topology.mockClear();
    (Game.map.getRoomStatus as jest.Mock).mockClear();
    (Game.map.getRoomTerrain as jest.Mock).mockClear();
    for (let index = 1; index <= 80; index += 1) {
      expect(measure({ ...input(), bankPos: pos(14 + Math.floor(index / 25)), haulerCarryParts: index % 25 + 1 }))
        .toEqual({ status: "pending", reason: "budget", retryAt: 1_001 });
    }
    expect(topology).not.toHaveBeenCalled();
    expect(Game.map.getRoomStatus).not.toHaveBeenCalled();
    expect(Game.map.getRoomTerrain).not.toHaveBeenCalled();
    expect(measure(ready).status).toBe("ready");
    expect(topology).toHaveBeenCalledTimes(1);
    expect(Game.map.getRoomStatus).not.toHaveBeenCalled();
    expect(search).toHaveBeenCalledTimes(3);
  });

  it.each(["source", "bank", "return", "avoid", "body", "topology"])("%s 输入变化失效旧测量", (change) => {
    const candidate = input();
    expect(measure(candidate).status).toBe("ready");
    Game.time += 1;
    if (change === "source") candidate.sourceSpawnPos = pos(9);
    if (change === "bank") candidate.bankPos = pos(14);
    if (change === "return") candidate.returnTargetPos = pos(8);
    if (change === "avoid") candidate.avoidRooms = ["E1N1"];
    if (change === "body") candidate.profile = {
      ...candidate.profile,
      attacker: { ...candidate.profile.attacker, body: [ATTACK, MOVE, MOVE] },
    };
    if (change === "topology") topology.mockReturnValue("changed");
    expect(measure(candidate).status).toBe("ready");
    expect(search).toHaveBeenCalledTimes(6);
  });

  it("visibility 与 route 变化独立进入 key；不可见中转房不要求构造假结构", () => {
    const source = "W0N0";
    const target = "E0N0";
    Game.rooms = { [source]: visibleRoom(source), [target]: visibleRoom(target) };
    search.mockImplementation((origin: RoomPosition) => ({
      path: origin.roomName === source
        ? [pos(0, 10, target), pos(1, 10, target)]
        : [pos(0, 10, target), pos(49, 10, source)],
      incomplete: false, ops: 1, cost: 2,
    }));
    const candidate = {
      ...input(), sourceSpawnPos: pos(49, 10, source), bankPos: pos(2, 10, target),
      returnTargetPos: pos(48, 10, source), routeRooms: [source, "W1N0", target],
    };
    expect(measure(candidate).status).toBe("ready");
    Game.time += 1;
    Game.rooms.W1N0 = visibleRoom("W1N0");
    expect(measure(candidate).status).toBe("ready");
    expect(search).toHaveBeenCalledTimes(6);
    Game.time += 1;
    candidate.routeRooms = [source, "W2N0", target];
    expect(measure(candidate).status).toBe("ready");
    expect(search).toHaveBeenCalledTimes(9);
  });

  it("cache hit 仍检查房间安全；callback 拒绝外房并仅返回静态矩阵 clone", () => {
    const candidate = input();
    expect(measure(candidate).status).toBe("ready");
    const callback = search.mock.calls[0][2].roomCallback as (room: string) => CostMatrix | false;
    expect(callback("W2N1")).toBe(false);
    const copied = callback("W1N1") as CostMatrix;
    expect(copied).not.toBe(staticMatrix);
    copied.set(20, 20, 255);
    expect(staticMatrix.get(20, 20)).toBe(0);
    // 同 tick 替换原生 reader 代表新输入，不能沿用已读 normal 事实。
    Game.map.getRoomStatus = jest.fn(() => ({ status: "closed", timestamp: null }));
    expect(measure(candidate)).toMatchObject({ status: "pending", reason: "unsafe_route" });
    expect(search).toHaveBeenCalledTimes(3);
  });

  it.each(["novice", "respawn"] as const)("接受 %s 同区域完整路径，null 状态仍拒绝且不消耗搜索", (status) => {
    (Game.map.getRoomStatus as jest.Mock).mockReturnValue({ status, timestamp: 10_000 });
    expect(measure(input()).status).toBe("ready");
    expect(search).toHaveBeenCalledTimes(3);
    Game.time += 1;
    (Game.map.getRoomStatus as jest.Mock).mockReturnValue(null);
    expect(measure(input())).toMatchObject({ status: "pending", reason: "unsafe_route" });
    expect(search).toHaveBeenCalledTimes(3);
  });

  it("目标不可见或路线中转房危险时不搜索；source/target 可出现在 avoid 集合", () => {
    delete Game.rooms.W1N1;
    expect(measure(input())).toMatchObject({ status: "pending", reason: "endpoint_not_visible" });
    expect(search).not.toHaveBeenCalled();
    Game.rooms.W1N1 = visibleRoom("W1N1");
    expect(measure({ ...input(), avoidRooms: ["W1N1"] }).status).toBe("ready");
    Game.rooms = { W0N0: visibleRoom("W0N0"), E0N0: visibleRoom("E0N0") };
    expect(measure({
      ...input(), sourceSpawnPos: pos(49, 10, "W0N0"), bankPos: pos(2, 10, "E0N0"),
      returnTargetPos: pos(48, 10, "W0N0"), routeRooms: ["W0N0", "W1N0", "E0N0"], avoidRooms: ["W1N0"],
    })).toMatchObject({ status: "pending", reason: "unsafe_route" });
    expect(search).toHaveBeenCalledTimes(3);
  });

  it("成功缓存有 TTL，且超过 64 项会淘汰旧测量", () => {
    const oldest = input();
    expect(measure(oldest).status).toBe("ready");
    for (let index = 1; index <= 64; index += 1) {
      Game.time += 1;
      expect(measure({ ...input(), bankPos: pos(14 + Math.floor(index / 25)), haulerCarryParts: index % 25 + 1 }).status)
        .toBe("ready");
    }
    const before = search.mock.calls.length;
    Game.time += 1;
    expect(measure(oldest).status).toBe("ready");
    expect(search).toHaveBeenCalledTimes(before + 3);
    Game.time += 99;
    expect(measure(oldest).status).toBe("ready");
    expect(search).toHaveBeenCalledTimes(before + 3);
    Game.time += 1;
    expect(measure(oldest).status).toBe("ready");
    expect(search).toHaveBeenCalledTimes(before + 6);
  });
});
