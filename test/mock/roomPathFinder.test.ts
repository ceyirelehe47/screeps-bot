import { searchSingleRoom } from "@mock/roomPathFinder";
import { MockRoomPosition, setupPathFinderGlobal, setupRoomPositionGlobal, setDefaultMapMocks } from "@mock/movement";

it("findPathTo 与 PathFinder 使用同一 A*，遵守相同矩阵、地形和 range", () => {
  setupRoomPositionGlobal(); setupPathFinderGlobal(); setDefaultMapMocks();
  const origin = new MockRoomPosition(10, 10, "W1N1") as unknown as RoomPosition;
  const goal = new RoomPosition(15, 10, "W1N1");
  const matrix = new PathFinder.CostMatrix();
  for (let y = 0; y < 50; y++) if (y !== 15) matrix.set(12, y, 255);
  const result = searchSingleRoom(origin, { pos: goal, range: 1 }, { maxOps: 8000, roomCallback: () => matrix });
  const path = origin.findPathTo(goal, { maxOps: 8000, range: 1, costCallback: () => matrix });
  expect(result.incomplete).toBe(false);
  expect(path.map(({ x, y }) => ({ x, y }))).toEqual(result.path.map(({ x, y }) => ({ x, y })));
  expect(path).toContainEqual(expect.objectContaining({ x: 12, y: 15 }));
  expect(path.every(step => Math.abs(step.dx) <= 1 && Math.abs(step.dy) <= 1)).toBe(true);
  expect(origin.findPathTo(goal, { maxOps: 1 })).toEqual([]);
  expect(searchSingleRoom(origin, { pos: goal, range: 0 }, { maxOps: 1 }).incomplete).toBe(true);
});
