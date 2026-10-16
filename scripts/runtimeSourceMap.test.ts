import { inflateSync } from "node:zlib";
import { runInNewContext } from "node:vm";

const { createRuntimeSourceMapModule, assertModuleSize } = require("./lib/runtimeSourceMap.cjs");

describe("Screeps 源码映射上传", () => {
  it("压缩模块保留所有位置映射，剔除源码正文", () => {
    const map = { version: 3, file: "main.js", sources: ["src/main.ts"], sourcesContent: ["私有正文"], names: ["loop"], mappings: "AAAA" };
    const module = { exports: {} as { encoding: string; blocks: Array<{ data: string }> } };
    runInNewContext(createRuntimeSourceMapModule(map), { module });
    expect(module.exports.encoding).toBe("positions-zlib-blocks-v1");
    const decoded = inflateSync(Buffer.from(module.exports.blocks[0].data, "base64"));
    expect([...new Int32Array(decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength))]).toEqual([1, 0, 1, 1, 0]);
    expect(module.exports).not.toHaveProperty("sourcesContent");
    expect(createRuntimeSourceMapModule(map)).not.toContain("私有正文");
  });

  it("统计 UTF-8 与 binary 字节，并在超出上传限额时阻断", () => {
    expect(assertModuleSize({ main: "中文", "data.wasm": { binary: "YQ==" } })).toBe(7);
    expect(assertModuleSize({ main: "a".repeat(5_000_000) })).toBe(5_000_000);
    expect(() => assertModuleSize({ main: "a".repeat(5_000_000), "main.js.map": "x" })).toThrow("超过");
  });
});
