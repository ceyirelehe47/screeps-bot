import { applySafeZoneLayer, clearSafeZoneLayersForTest } from "@/movement/safeZoneLayer";
import { resolveMovementPolicy } from "@/movement/pathing";
import * as helpers from "@/runtime/safeZoneHelpers";
import * as safeZone from "@/runtime/safeZone";
import { setupPathFinderGlobal } from "@mock/movement";

beforeEach(() => { Game.time++; setupPathFinderGlobal(); clearSafeZoneLayersForTest(); });

it("安全区矩阵复用稳定层，克隆隔离，zone revision 和布局 key 变更后重建", () => {
  const zone = new Set([10 * 50 + 10]), policy = { roomName: "W1N1", revision: 1, zone };
  const first = applySafeZoneLayer(new PathFinder.CostMatrix(), policy, "layout:1");
  expect(first.get(10, 10)).toBe(0); expect(first.get(11, 10)).toBe(255);
  first.set(10, 10, 255);
  const input = new PathFinder.CostMatrix(); const set = jest.spyOn(input, "set");
  const next = applySafeZoneLayer(input, policy, "layout:1");
  expect(set).not.toHaveBeenCalled(); expect(next.get(10, 10)).toBe(0);
  const changed = new PathFinder.CostMatrix(); changed.set(10, 10, 20);
  expect(applySafeZoneLayer(changed, policy, "layout:2").get(10, 10)).toBe(20);
  expect(applySafeZoneLayer(new PathFinder.CostMatrix(), { ...policy, revision: 2, zone: new Set([11 * 50 + 10]) }, "layout:1").get(10, 10)).toBe(255);
});

it("安全区自带稳定 key，无 key 的自定义 callback 仍禁止缓存，不替业务猜测版本", () => {
  const creep = { body: [], name: "worker", room: { name: "W1N1" }, memory: { role: "worker" } } as unknown as Creep;
  const restrict = jest.spyOn(helpers, "shouldRestrictToSafeZone").mockReturnValue(true);
  const zone = jest.spyOn(safeZone, "getSafeZone").mockReturnValue(new Set([1]));
  try {
    const first = resolveMovementPolicy(creep, {});
    expect(first.cacheKey).toContain("sz:W1N1:");
    expect(resolveMovementPolicy(creep, {}).cacheKey).toBe(first.cacheKey);
    expect(resolveMovementPolicy(creep, { costCallback: (_room, matrix) => matrix }).cacheKey).toBeUndefined();
    expect(resolveMovementPolicy(creep, { cacheKey: "custom:1", costCallback: (_room, matrix) => matrix }).cacheKey).toContain("custom:1|sz:");
  } finally { restrict.mockRestore(); zone.mockRestore(); }
});
