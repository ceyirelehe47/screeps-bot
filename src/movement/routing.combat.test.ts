import { clearRoutingCachesForTest, getNextTravelRoom } from "@/movement/routing";
import { resetRuntimeServices } from "@mock/movement";
import { createMockStore } from "@mock/powerBank";

const SOURCE = "E0N0", MIDDLE = "E1N0", TARGET = "E2N0";
let tower: StructureTower;
beforeEach(() => {
  jest.clearAllMocks();
  Game.time++;
  Memory.data = {};
  Game.creeps = {}; Game.spawns = {};
  tower = { structureType: STRUCTURE_TOWER, store: createMockStore({ [RESOURCE_ENERGY]: 9 }) } as StructureTower;
  Game.rooms = { [MIDDLE]: { name: MIDDLE, controller: { owner: { username: "npc" } },
    find: jest.fn((kind: FindConstant) => kind === FIND_HOSTILE_STRUCTURES ? [tower] : []) } as unknown as Room };
  Game.map = { ...Game.map, getRoomStatus: jest.fn(() => ({ status: "normal", timestamp: null })),
    findRoute: jest.fn((_from: string, _to: string, options?: Parameters<GameMap["findRoute"]>[2]) => !options?.routeCallback || Number.isFinite(options.routeCallback(MIDDLE, SOURCE))
      ? [{ exit: RIGHT, room: MIDDLE }, { exit: RIGHT, room: TARGET }] : ERR_NO_PATH) };
  resetRuntimeServices(); clearRoutingCachesForTest();
});

it("清剿可续接无实际塔伤的中途房，经济角色不复用其缓存", () => {
  expect(getNextTravelRoom(SOURCE, TARGET)).toBeNull();
  expect(getNextTravelRoom(SOURCE, TARGET, undefined, undefined, "combat")).toBe(MIDDLE);
  expect(getNextTravelRoom(SOURCE, TARGET)).toBeNull();
});
it("下一tick实际补能后重新校验清剿缓存，而不是沿用25tick旧安全结论", () => {
  expect(getNextTravelRoom(SOURCE, TARGET, undefined, undefined, "combat")).toBe(MIDDLE);
  tower.store[RESOURCE_ENERGY] = 10;
  Game.time++;
  expect(getNextTravelRoom(SOURCE, TARGET, undefined, undefined, "combat")).toBeNull();
});
it("清剿仍遵守显式避让房间", () => {
  expect(getNextTravelRoom(SOURCE, TARGET, undefined, [MIDDLE], "combat")).toBeNull();
});

it("炮塔失去开火能力后不等25tick负缓存，再次允许续路", () => {
  tower.store[RESOURCE_ENERGY] = 10;
  expect(getNextTravelRoom(SOURCE, TARGET, undefined, undefined, "combat")).toBeNull();
  tower.store[RESOURCE_ENERGY] = 9;
  Game.time++;
  expect(getNextTravelRoom(SOURCE, TARGET, undefined, undefined, "combat")).toBe(MIDDLE);
});
