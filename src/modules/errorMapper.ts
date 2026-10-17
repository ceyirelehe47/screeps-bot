import { unzlibSync } from "fflate";

function decodeBase64(value: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const output = new Uint8Array(value.length / 4 * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0));
  let bits = 0;
  let count = 0;
  let index = 0;
  for (const character of value) {
    if (character === "=") break;
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error("无效的 source map base64");
    bits = (bits << 6) | digit;
    count += 6;
    if (count >= 8) {
      count -= 8;
      output[index++] = (bits >> count) & 255;
    }
  }
  return output;
}

interface StackMapConsumer {
  originalPositionFor(position: { line: number; column: number }): {
    source: string | null; line: number | null; column: number | null; name?: string | null;
  };
}

function indexedConsumer(loaded: { sources: string[]; blocks: Array<{ line: number; column: number; data: string }> }): StackMapConsumer {
  // 只解码错误栈实际涉及的位置块，避免首次异常解析数十万个位置。
  const blocks = new Map<number, DataView>();
  const readBlock = (index: number): DataView => {
    const cached = blocks.get(index);
    if (cached) return cached;
    const bytes = unzlibSync(decodeBase64(loaded.blocks[index].data));
    if (bytes.byteLength % 20 !== 0) throw new Error("无效的 source map 位置索引");
    const positions = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const previous = [0, 0, 0, 0, 0];
    for (let offset = 0; offset < bytes.byteLength; offset += 4) {
      const field = (offset / 4) % 5;
      previous[field] += positions.getInt32(offset, true);
      positions.setUint32(offset, previous[field], true);
    }
    if (blocks.size >= 16) {
      const oldest = blocks.keys().next().value;
      if (oldest !== undefined) blocks.delete(oldest);
    }
    blocks.set(index, positions);
    return positions;
  };
  return {
    originalPositionFor({ line, column }) {
      let low = 0;
      let high = loaded.blocks.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const block = loaded.blocks[middle];
        if (block.line < line || block.line === line && block.column <= column) low = middle + 1;
        else high = middle;
      }
      if (low === 0) return { source: null, line: null, column: null, name: null };
      const positions = readBlock(low - 1);
      low = 0;
      high = positions.byteLength / 20;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const generatedLine = positions.getUint32(middle * 20, true);
        const generatedColumn = positions.getUint32(middle * 20 + 4, true);
        if (generatedLine < line || generatedLine === line && generatedColumn <= column) low = middle + 1;
        else high = middle;
      }
      const offset = (low - 1) * 20;
      if (offset < 0 || positions.getUint32(offset, true) !== line) return { source: null, line: null, column: null, name: null };
      const source = positions.getUint32(offset + 8, true);
      if (source === 0) return { source: null, line: null, column: null, name: null };
      return {
        source: loaded.sources[source - 1],
        line: positions.getUint32(offset + 12, true),
        column: positions.getUint32(offset + 16, true),
        name: null,
      };
    },
  };
}

let consumer: StackMapConsumer | null = null;
const cache = new Map<string, string>();
const STACK_CACHE_LIMIT = 100;
let sourceMapDisabled = false;

function getConsumer(): StackMapConsumer | null {
  if (sourceMapDisabled) {
    return null;
  }

  if (consumer === null) {
    try {
      const loaded = require("main.js.map");
      if (loaded.encoding !== "positions-zlib-blocks-v1") throw new Error("不支持的 source map 编码");
      consumer = indexedConsumer(loaded);
    } catch {
      sourceMapDisabled = true;
      return null;
    }
  }
  return consumer;
}

function sourceMappedStackTrace(error: Error | string): string {
  const stack = error instanceof Error ? error.stack || String(error) : error;
  const cached = cache.get(stack);
  if (cached !== undefined) return cached;

  // V8 列号从 1 起，source-map 使用从 0 起的列号；保留非 bundle 帧和原始栈。
  const outStack = stack.replace(
    /^(\s+at\s+(?:.*?\s+\()?)(main(?:\.js)?):(\d+):(\d+)(\)?)$/gm,
    (frame, prefix: string, _file: string, line: string, column: string, suffix: string) => {
      const mapConsumer = getConsumer();
      if (!mapConsumer) return frame;
      const pos = mapConsumer.originalPositionFor({
        line: Number.parseInt(line, 10),
        column: Math.max(0, Number.parseInt(column, 10) - 1),
      });
      if (pos.line === null || pos.source === null) return frame;
      return `${prefix}${pos.source}:${pos.line}:${(pos.column ?? 0) + 1}${suffix}`;
    },
  );
  if (cache.size >= STACK_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(stack, outStack);
  return outStack;
}

/** 错误报告本身不得中断后续 phase；兼容字符串、普通对象等任意 throw 值。 */
export function reportRuntimeError(scope: string, error: unknown): void {
  let message: string;
  try {
    message = error instanceof Error ? error.stack || String(error) : String(error);
  } catch {
    message = "无法格式化的异常";
  }
  try {
    if (!Game.rooms.sim && error instanceof Error) message = sourceMappedStackTrace(error);
  } catch {
    // 缺失或损坏的 map 不得掩盖原始错误。
  }
  try {
    console.log(`<text style="color:#ef9a9a">${_.escape(`[${scope}] ${message}`)}</text>`);
  } catch {
    // 日志设施异常时仍保留调度边界的隔离语义。
  }
}

export function errorMapper(next: () => void): () => void {
  return (): void => {
    try {
      next();
    } catch (error) {
      reportRuntimeError("loop", error);
    }
  };
}
