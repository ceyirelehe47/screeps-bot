import { SourceMapGenerator, SourceMapConsumer } from "source-map";
import { runInNewContext } from "node:vm";

const { createRuntimeSourceMapModule } = require("../../scripts/lib/runtimeSourceMap.cjs");

// Screeps 会将上传的 main.js.map.js 模块解析为 main.js.map。
jest.mock("main.js.map", () => ({}), { virtual: true });

describe("运行时异常报告", () => {
  let log: jest.SpyInstance;
  beforeEach(() => {
    jest.resetModules();
    log = jest.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => log.mockRestore());

  function loadMap(map: unknown) {
    jest.doMock("main.js.map", () => map, { virtual: true });
    return require("./errorMapper") as typeof import("./errorMapper");
  }

  it("映射 main 与 main.js 的栈帧，保留其它帧并正确换算列号", () => {
    const generator = new SourceMapGenerator({ file: "main.js" });
    generator.addMapping({ generated: { line: 5, column: 9 }, original: { line: 42, column: 3 }, source: "src/runtime/warControl.ts" });
    const module = { exports: {} };
    runInNewContext(createRuntimeSourceMapModule(JSON.parse(generator.toString())), { module });
    const { reportRuntimeError } = loadMap(module.exports);
    const error = new Error("故障");
    error.stack = "Error: 故障\n    at native (native:1:1)\n    at run (main:5:10)\n    at main.js:5:10\n    at other (other:8:2)";
    reportRuntimeError("phase:warControl", error);
    expect(log.mock.calls[0][0]).toContain("src/runtime/warControl.ts:42:4");
    expect(log.mock.calls[0][0]).toContain("native:1:1");
    expect(log.mock.calls[0][0]).toContain("other:8:2");
  });

  it("索引查询与标准 source-map 的边界、空映射和跨行行为一致", () => {
    const generator = new SourceMapGenerator({ file: "main.js" });
    generator.addMapping({ generated: { line: 1, column: 2 }, source: "a.ts", original: { line: 10, column: 4 } });
    generator.addMapping({ generated: { line: 1, column: 9 }, original: null, source: null });
    generator.addMapping({ generated: { line: 2, column: 0 }, source: "b.ts", original: { line: 20, column: 6 } });
    generator.addMapping({ generated: { line: 2, column: 9 }, source: "a.ts", original: { line: 3, column: 2 } });
    generator.addMapping({ generated: { line: 2, column: 9 }, source: "b.ts", original: { line: 5, column: 1 } });
    const raw = JSON.parse(generator.toString());
    const standard = new SourceMapConsumer(raw);
    const module = { exports: {} };
    runInNewContext(createRuntimeSourceMapModule(raw), { module });
    const { reportRuntimeError } = loadMap(module.exports);
    for (const [line, column] of [[1, 0], [1, 2], [1, 8], [1, 9], [2, 0], [2, 9], [2, 99], [3, 0]]) {
      const expected = standard.originalPositionFor({ line, column });
      const error = new Error("索引边界");
      const frame = `main:${line}:${column + 1}`;
      error.stack = `Error: 索引边界\n    at ${frame}`;
      reportRuntimeError("test", error);
      const output = log.mock.calls[log.mock.calls.length - 1][0];
      expect(output).toContain(expected.source === null ? frame : `${expected.source}:${expected.line}:${expected.column! + 1}`);
    }
  });

  it("跨分块边界及缓存淘汰后仍与标准映射器一致", () => {
    const generator = new SourceMapGenerator({ file: "main.js" });
    for (let i = 0; i < 18 * 1024; i++) generator.addMapping({
      generated: { line: 1, column: i * 3 }, source: `${i % 3}.ts`,
      original: { line: Math.floor(i / 20) + 1, column: i % 20 },
    });
    const raw = JSON.parse(generator.toString());
    const standard = new SourceMapConsumer(raw);
    const module = { exports: {} };
    runInNewContext(createRuntimeSourceMapModule(raw), { module });
    const { reportRuntimeError } = loadMap(module.exports);
    const columns = [1023 * 3, 1024 * 3 - 1, ...Array.from({ length: 18 }, (_, index) => index * 1024 * 3), 0];
    columns.forEach((column, index) => {
      const expected = standard.originalPositionFor({ line: 1, column });
      const error = new Error(`分块 ${index}`);
      error.stack = `Error: 分块 ${index}\n    at main:1:${column + 1}`;
      reportRuntimeError("test", error);
      expect(log.mock.calls[log.mock.calls.length - 1][0]).toContain(`${expected.source}:${expected.line}:${expected.column + 1}`);
    });
  });

  it("缺失或损坏的 map、非 Error throw 和格式化异常保留隔离语义", () => {
    const { errorMapper, reportRuntimeError } = loadMap({ broken: true });
    const error = new Error("原始错误");
    error.stack = "Error: 原始错误\n    at main:5:10";
    reportRuntimeError("phase:test", error);
    expect(log.mock.calls[0][0]).toContain("main:5:10");
    for (const thrown of ["<throw>", null, undefined, 42, { toString: () => { throw new Error("格式化失败"); } }]) {
      expect(() => errorMapper(() => { throw thrown; })()).not.toThrow();
    }
    expect(log.mock.calls.flat().join(" ")).toContain("&lt;throw&gt;");
    log.mockImplementation(() => { throw new Error("日志失败"); });
    expect(() => reportRuntimeError("phase:test", error)).not.toThrow();
  });
});
