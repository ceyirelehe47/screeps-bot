import { MAX_TICK_PATH_SEARCH_OPS, resetPathSearchBudgetForTest, searchMovementPath, searchPlanningPath } from "@/movement/pathSearch";
import { resolveMoveProfile } from "@/movement/moveProfile";
import { MockRoomPosition, setupPathFinderGlobal } from "@mock/movement";

beforeEach(() => { Game.time++; resetPathSearchBudgetForTest(); setupPathFinderGlobal(); });

it("完整性和 maxOps 独立，profile 的完整路径不会隐式扩大自定义上限", () => {
  expect(resolveMoveProfile({ completeness: "complete" }).maxOps).toBe(8000);
  expect(resolveMoveProfile({ profile: "combat", maxOps: 3000 })).toMatchObject({ completeness: "complete", maxOps: 3000 });
  expect(resolveMoveProfile({ profile: "travel" })).toMatchObject({ completeness: "allowPartial", partialTtl: 2 });
});

it("单 tick 全局 ops 上限限制后续请求，预算拒绝不再调用搜索器；下一 tick 自动恢复", () => {
  const origin = new MockRoomPosition(10, 10, "W1N1") as unknown as RoomPosition;
  const target = { pos: new MockRoomPosition(20, 20, "W1N1") as unknown as RoomPosition, range: 1 };
  jest.mocked(PathFinder.search).mockImplementation((_origin, _goals, options) => ({ path: [], incomplete: true, cost: 0, ops: options!.maxOps! }));
  for (let used = 0; used < MAX_TICK_PATH_SEARCH_OPS; used += 32000) {
    expect(searchMovementPath(origin, target, { maxOps: 32000 }).reason).toBe("budgetExhausted");
  }
  const calls = jest.mocked(PathFinder.search).mock.calls.length;
  expect(searchMovementPath(origin, target, { maxOps: 8000 })).toMatchObject({ allocatedOps: 0, reason: "budgetExhausted", ops: 0 });
  expect(PathFinder.search).toHaveBeenCalledTimes(calls);
  Game.time++;
  expect(searchMovementPath(origin, target, { maxOps: 8000 }).allocatedOps).toBe(8000);
  expect(PathFinder.search).toHaveBeenCalledTimes(calls + 1);
});

it("未用完预算的 incomplete 与预算耗尽不同，完整搜索只调用一次", () => {
  const origin = new MockRoomPosition(10, 10, "W1N1") as unknown as RoomPosition;
  const target = { pos: origin, range: 0 };
  jest.mocked(PathFinder.search).mockReturnValueOnce({ path: [], incomplete: true, cost: 1, ops: 5 });
  expect(searchMovementPath(origin, target, { maxOps: 8000 })).toMatchObject({ reason: "searchExhausted", ops: 5 });
  jest.mocked(PathFinder.search).mockReturnValueOnce({ path: [origin], incomplete: false, cost: 1, ops: 2 });
  expect(searchMovementPath(origin, target, { maxOps: 8000 }).reason).toBe("complete");
  expect(PathFinder.search).toHaveBeenCalledTimes(2);
});

it("早期规划只能使用半数额度，不能挤占稍后 creepWork 的移动预算", () => {
  const origin = new MockRoomPosition(10, 10, "W1N1") as unknown as RoomPosition;
  const target = { pos: origin, range: 0 };
  jest.mocked(PathFinder.search).mockImplementation((_origin, _goals, opts) => ({ path: [], cost: 0, ops: opts!.maxOps!, incomplete: true }));
  expect([1, 2, 3].map(() => searchPlanningPath(origin, target, { maxOps: 32000 }).allocatedOps)).toEqual([32000, 32000, 16000]);
  expect(searchPlanningPath(origin, target, { maxOps: 8000 }).allocatedOps).toBe(0);
  expect(searchMovementPath(origin, target, { maxOps: 32000 }).allocatedOps).toBe(32000);
});

it("原生搜索抛错仍占用预留额度，失败调用不能绕过 tick 上限", () => {
  const origin = new MockRoomPosition(10, 10, "W1N1") as unknown as RoomPosition;
  jest.mocked(PathFinder.search).mockImplementation(() => { throw new Error("engine failure"); });
  for (let used = 0; used < MAX_TICK_PATH_SEARCH_OPS; used += 32000) {
    expect(() => searchMovementPath(origin, { pos: origin, range: 0 }, { maxOps: 32000 })).toThrow("engine failure");
  }
  expect(searchMovementPath(origin, { pos: origin, range: 0 }, { maxOps: 8000 }).allocatedOps).toBe(0);
  expect(PathFinder.search).toHaveBeenCalledTimes(5);
});
