import { clearMatrixLayer, matrixLayerSize, readMatrixLayer } from "@/movement/matrixCache";
import { MockCostMatrix } from "@mock/movement";

beforeEach(() => { clearMatrixLayer("static"); clearMatrixLayer("travel"); Game.time++; });

it("静态与派生层均只外露 clone，业务和搜索器的修改不会污染缓存原件", () => {
  const build = jest.fn(() => new MockCostMatrix() as unknown as CostMatrix);
  const first = readMatrixLayer("static", "W1N1", "layout1", build, 2);
  first.matrix.set(10, 10, 255);
  const next = readMatrixLayer("static", "W1N1", "layout1", build, 2);
  expect(next.built).toBe(false); expect(next.matrix.get(10, 10)).toBe(0);
  const travel = readMatrixLayer("travel", "W1N1", "layout1", () => {
    const matrix = next.matrix.clone(); matrix.set(20, 20, 254); return matrix;
  }, 2);
  travel.matrix.set(20, 20, 0);
  expect(readMatrixLayer("travel", "W1N1", "layout1", build, 2).matrix.get(20, 20)).toBe(254);
  expect(next.matrix.get(20, 20)).toBe(0);
  expect(build).toHaveBeenCalledTimes(1);
});

it("布局 revision、时间回退和容量边界都使旧值失效，普通跨 tick 读取仍命中", () => {
  const build = jest.fn(() => new MockCostMatrix() as unknown as CostMatrix);
  readMatrixLayer("static", "W1N1", "old", build, 2);
  Game.time++;
  expect(readMatrixLayer("static", "W1N1", "old", build, 2).built).toBe(false);
  expect(readMatrixLayer("static", "W1N1", "new", build, 2).built).toBe(true);
  readMatrixLayer("static", "W2N2", "new", build, 2);
  readMatrixLayer("static", "W3N3", "new", build, 2);
  expect(matrixLayerSize("static")).toBe(2);
  expect(readMatrixLayer("static", "W1N1", "new", build, 2).built).toBe(true);
  Game.time--;
  expect(readMatrixLayer("static", "W1N1", "new", build, 2).built).toBe(true);
});
