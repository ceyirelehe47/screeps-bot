jest.mock("@/movement/pathing", () => ({ getRoomStaticMatrix: () => ({ get: () => 0 }) }));
import { colonizationHarvesterPreSpawnThreshold } from "@/runtime/colonizationHarvesterPreSpawn";
import { runMemoryCleanup } from "@/runtime/memoryCleanup";
import type { CreepConfig } from "@/types/system";

let tick = 200000;
const NAME = "E1N57:colonizationSupport:E4N57:harvester:source-a";
const CONFIG: CreepConfig = { role: "colonizerHarvester", roomName: "E1N57",
  args: ["E4N57", "source-a", "E1N57|E2N57|E3N57|E4N57"] };
const BODY: BodyPartConstant[] = [...Array(5).fill(WORK), ...Array(5).fill(MOVE)];
function spawn(): StructureSpawn {
  return { room: { name: "E1N57" }, pos: { x: 25, y: 25, roomName: "E1N57" } } as unknown as StructureSpawn;
}
describe("新房增援矿工完整路线提前补员", () => {
  beforeEach(() => {
    Game.time = tick += 10000; Memory.runtime = {};
    delete (global as typeof global & { __runtimeServices?: unknown }).__runtimeServices;
    Memory.cfg = { colonizationSupport: { E4N57: { sourceRoom: "E1N57", enabled: true } } };
    Game.map = { getRoomLinearDistance: () => 3, getRoomTerrain: () => ({ get: () => 0 }) } as unknown as GameMap;
    Game.getObjectById = jest.fn(() => ({ pos: { x: 37, y: 7, roomName: "E4N57" } })) as unknown as typeof Game.getObjectById;
    (global as unknown as { RoomPosition: unknown }).RoomPosition = class {
      constructor(public x: number, public y: number, public roomName: string) {}
    };
    (global as unknown as { PathFinder: unknown }).PathFinder = { search: jest.fn(() => ({ incomplete: false,
      path: Array.from({ length: 100 }, () => ({ x: 20, y: 20, roomName: "E4N57" })) })) };
  });
  it("完整100tick通勤加孵化和缓冲，只在许可路线搜索且缓存复用", () => {
    expect(colonizationHarvesterPreSpawnThreshold(spawn(), NAME, CONFIG, BODY)).toBe(160);
    expect(colonizationHarvesterPreSpawnThreshold(spawn(), NAME, CONFIG, BODY)).toBe(160);
    expect(PathFinder.search).toHaveBeenCalledTimes(1);
    const options = (PathFinder.search as jest.Mock).mock.calls[0][2];
    expect(options.maxRooms).toBe(4); expect(options.maxOps).toBe(2000);
    expect(options.roomCallback("E0N0")).toBe(false);
  });
  it("部分路径与矿点对象缺失均保留三跳通勤预算，不降为零", () => {
    (PathFinder.search as jest.Mock).mockReturnValue({ incomplete: true, path: [{ x: 20, y: 20, roomName: "E1N57" }] });
    expect(colonizationHarvesterPreSpawnThreshold(spawn(), NAME, CONFIG, BODY)).toBe(510);
    Memory.runtime = {}; Game.time++;
    Game.getObjectById = jest.fn(() => null) as typeof Game.getObjectById;
    expect(colonizationHarvesterPreSpawnThreshold(spawn(), NAME, CONFIG, BODY)).toBe(510);
  });
  it("通勤缓存跨过定期清理仍复用，过期和母房丢失后才移除", () => {
    Game.creeps = {}; Game.spawns = {}; Memory.creeps = {}; Memory.data = undefined;
    Game.rooms = { E1N57: { name: "E1N57", controller: { my: true, level: 8 }, memory: {}, find: () => [] } as unknown as Room };
    expect(colonizationHarvesterPreSpawnThreshold(spawn(), NAME, CONFIG, BODY)).toBe(160);
    Game.time += 17 - Game.time % 17;
    runMemoryCleanup();
    expect(colonizationHarvesterPreSpawnThreshold(spawn(), NAME, CONFIG, BODY)).toBe(160);
    expect(PathFinder.search).toHaveBeenCalledTimes(1);
    Game.time += 1003;
    Game.time += 17 - Game.time % 17;
    runMemoryCleanup();
    expect(colonizationHarvesterPreSpawnThreshold(spawn(), NAME, CONFIG, BODY)).toBe(160);
    expect(PathFinder.search).toHaveBeenCalledTimes(2);
    Game.rooms = {}; Game.time += 17;
    runMemoryCleanup();
    expect(Memory.runtime?.spawnPlanner?.sourceWorkerCommutes).toBeUndefined();
  });
  it("常规外矿配置不进入新房支援补员策略", () => {
    expect(colonizationHarvesterPreSpawnThreshold(spawn(), "E1N57:remoteMine:E4N57:harvester:source-a", CONFIG, BODY)).toBeUndefined();
    expect(PathFinder.search).not.toHaveBeenCalled();
  });
});
