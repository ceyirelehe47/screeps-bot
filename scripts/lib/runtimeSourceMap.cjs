// 将完整位置映射预编译为排序索引，运行时避免 source-map 的对象解析与排序。
const { deflateSync } = require("node:zlib");
const { SourceMapConsumer } = require("source-map");
const CODE_SIZE_LIMIT = 5_000_000;

function createRuntimeSourceMapModule(map) {
  const sources = [];
  const sourceIds = new Map();
  const blocks = [];
  let records = [];
  const flushBlock = () => {
    if (records.length === 0) return;
    const bytes = Buffer.alloc(records.length * 4);
    const previous = [0, 0, 0, 0, 0];
    for (let index = 0; index < records.length; index++) {
      const field = index % 5;
      bytes.writeInt32LE(records[index] - previous[field], index * 4);
      previous[field] = records[index];
    }
    blocks.push({ line: records[0], column: records[1], data: deflateSync(bytes, { level: 9 }).toString("base64") });
    records = [];
  };
  const consumer = new SourceMapConsumer(map);
  let lastLine = -1;
  let lastColumn = -1;
  consumer.eachMapping((entry) => {
    // source-map 对相同生成位置选择第一条；空 source 也必须保留为边界。
    if (entry.generatedLine === lastLine && entry.generatedColumn === lastColumn) return;
    lastLine = entry.generatedLine;
    lastColumn = entry.generatedColumn;
    let sourceId = 0;
    if (entry.originalLine !== null && entry.source !== null) {
      if (!sourceIds.has(entry.source)) {
        sources.push(entry.source);
        sourceIds.set(entry.source, sources.length);
      }
      sourceId = sourceIds.get(entry.source);
    }
    records.push(lastLine, lastColumn, sourceId, entry.originalLine ?? 0, entry.originalColumn ?? 0);
    if (records.length >= 1024 * 5) flushBlock();
  }, null, SourceMapConsumer.GENERATED_ORDER);
  flushBlock();
  return `module.exports=${JSON.stringify({ encoding: "positions-zlib-blocks-v1", sources, blocks })};\n`;
}

function assertModuleSize(modules) {
  const bytes = Object.values(modules).reduce((total, value) =>
    total + (typeof value === "string" ? Buffer.byteLength(value, "utf8") : Buffer.from(value.binary, "base64").length), 0);
  if (bytes > CODE_SIZE_LIMIT) throw new Error(`Screeps 模块总量 ${bytes} 字节超过 ${CODE_SIZE_LIMIT} 字节限制`);
  return bytes;
}

module.exports = { createRuntimeSourceMapModule, assertModuleSize };
