/** 完整数据树证明：JSON 忽略的隐藏字段不能参与账本等价缓存。 */
function jsonDataTree(raw: unknown, seen = new WeakSet<object>(), depth = 0): boolean {
  if (raw === null || typeof raw === "string" || typeof raw === "boolean") return true;
  if (typeof raw === "number") return Number.isFinite(raw);
  if (typeof raw !== "object" || depth > 12 || seen.has(raw) ||
      Object.getOwnPropertySymbols(raw).length !== 0 || "toJSON" in raw) return false;
  const array = Array.isArray(raw);
  if (array ? Object.getPrototypeOf(raw) !== Array.prototype || raw.length > 512 :
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return false;
  const keys = Object.getOwnPropertyNames(raw);
  if (array ? keys.length !== raw.length + 1 : keys.length > 64) return false;
  seen.add(raw);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !("value" in descriptor)) return false;
    if (array && key === "length") continue;
    if (!descriptor.enumerable || array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= raw.length)) return false;
    if (!jsonDataTree(descriptor.value, seen, depth + 1)) return false;
  }
  seen.delete(raw);
  return true;
}

export function treasuryContinuousOHDataToken(raw: unknown): string | null {
  try {
    if (raw === undefined) return "absent";
    if (raw === null || typeof raw !== "object" || Array.isArray(raw) || !jsonDataTree(raw)) return null;
    return JSON.stringify(raw);
  } catch { return null; }
}

/** 与 Memory 硬字节门共用 UTF-8 口径；复用已经完整校验的 JSON 字节。 */
export function treasuryContinuousOHJSONBytes(serialized: string): number {
  let bytes = 0;
  for (let i = 0; i < serialized.length; i += 1) {
    const code = serialized.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < serialized.length &&
        serialized.charCodeAt(i + 1) >= 0xdc00 && serialized.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i += 1; }
    else bytes += 3;
  }
  return bytes;
}
