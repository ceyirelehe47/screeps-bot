import { clearDepositPathCacheForTest, measureDepositReturn, measureDepositTravel } from "@/runtime/depositPathDistance";
import { getCachedStaticTravelMatrix } from "@/movement/routing";
import { getRoomTopologyRevision } from "@/movement/roomTopologyRevision";

jest.mock("@/movement/routing", () => ({ getCachedStaticTravelMatrix: jest.fn() }));
jest.mock("@/movement/roomTopologyRevision", () => ({ getRoomTopologyRevision: jest.fn() }));
function pos(x: number, roomName: string): RoomPosition { return { x, y: 20, roomName } as RoomPosition; }
function room(name: string): Room {
  return { name, find: jest.fn(() => []), controller: undefined } as unknown as Room;
}
function input() {
  return { origin: pos(48, "E1N1"), target: pos(2, "E2N1"), returnTarget: pos(45, "E1N1"),
    body: [WORK, CARRY, MOVE, MOVE] as BodyPartConstant[], loadedAmount: 50,
    routeRooms: ["E1N1", "E2N1"], avoidRooms: [] as string[] };
}
const outbound = [pos(49, "E1N1"), pos(0, "E2N1"), pos(1, "E2N1")];
const returned = [pos(0, "E2N1"), pos(49, "E1N1"), pos(48, "E1N1"), pos(47, "E1N1"), pos(46, "E1N1")];
beforeEach(() => {
  jest.clearAllMocks(); clearDepositPathCacheForTest(); Game.time = 100; Memory.runtime = {};
  Game.rooms = { E1N1: room("E1N1"), E2N1: room("E2N1") };
  Game.map = { getRoomStatus: jest.fn(() => ({ status: "normal" })),
    getRoomTerrain: jest.fn(() => ({ get: jest.fn(() => 0) })) } as unknown as GameMap;
  const matrix = { get: jest.fn(() => 0), clone: jest.fn(() => matrix) } as unknown as CostMatrix;
  jest.mocked(getCachedStaticTravelMatrix).mockReturnValue(matrix);
  jest.mocked(getRoomTopologyRevision).mockReturnValue("v1");
  let calls = 0;
  Object.assign(global, { PathFinder: { search: jest.fn(() => ({ incomplete: false, path: calls++ % 2 === 0 ? outbound : returned })) } });
});
describe("Deposit 完整去返路径证据", () => {
  it("两段PF并验证跨房连续与满载疲劳", () => {
    const result = measureDepositTravel(input());
    expect(result).toMatchObject({ status: "ready", outboundTravelTicks: 3, returnTravelTicks: 5 });
    expect(PathFinder.search).toHaveBeenCalledTimes(2);
  });
  it("沼泽和满载身体不同，不能用格数代替耗时", () => {
    jest.mocked(Game.map.getRoomTerrain).mockReturnValue({ get: () => TERRAIN_MASK_SWAMP } as RoomTerrain);
    expect(measureDepositTravel(input())).toMatchObject({ status: "ready", outboundTravelTicks: 9, returnTravelTicks: 25 });
  });
  it("不接受incomplete、跳格或隔房range伪到达", () => {
    jest.mocked(PathFinder.search).mockReturnValue({ incomplete: true, path: outbound } as PathFinderPath);
    expect(measureDepositTravel(input())).toMatchObject({ status: "pending", reason: "path_incomplete" });
    Game.time += 6; clearDepositPathCacheForTest();
    jest.mocked(PathFinder.search).mockReturnValue({ incomplete: false, path: [pos(1, "E2N1")] } as PathFinderPath);
    expect(measureDepositTravel(input())).toMatchObject({ status: "pending", reason: "path_incomplete" });
  });
  it("缓存命中仍检查fresh安全与拓扑；新测量预算不能旁路", () => {
    expect(measureDepositTravel(input()).status).toBe("ready");
    expect(measureDepositTravel(input()).status).toBe("ready");
    expect(PathFinder.search).toHaveBeenCalledTimes(2);
    Memory.runtime!.transitDangerRooms = { E2N1: Game.time + 10 };
    expect(measureDepositTravel(input())).toMatchObject({ status: "pending", reason: "unsafe_route" });
    delete Memory.runtime!.transitDangerRooms;
    jest.mocked(getRoomTopologyRevision).mockReturnValue("v2");
    expect(measureDepositTravel(input())).toMatchObject({ status: "pending", reason: "budget" });
  });
  it("当前activebody真实回程允许不同owned接收房，不回退房间距离", () => {
    jest.mocked(PathFinder.search).mockReturnValue({ incomplete: false, path: returned } as PathFinderPath);
    const result = measureDepositReturn({ ...input(), origin: pos(1, "E2N1"), routeRooms: ["E2N1", "E1N1"] });
    expect(result).toMatchObject({ status: "ready", returnTravelTicks: 5 });
    expect(PathFinder.search).toHaveBeenCalledTimes(1);
  });
});
