/**
 * Treasury 安全 canonical encoding（第九轮 4.11）——action contract 的
 * canonical args 编码权威。
 *
 * 动机：第八轮 contract digest 使用 `JSON.stringify(args)`——普通对象键序
 * 敏感（插入顺序不同 digest 不同）、`{a:undefined}` 与 `{}` 静默碰撞、NaN 与
 * null 静默碰撞、cyclic 抛出中断 tick、getter 每次读取可产生不同值。本模块
 * 一次遍历完成"冻结深拷贝 + 确定性文本编码"，输出同一 canonical frozen args
 * 供 adapter 的 validate/derivePostings/execute 观察与 digest 计算：
 *
 * - **确定性**：普通对象自有键排序后拼接（消除插入顺序差异）；数组保持元素
 *   顺序（顺序即语义）；文本编码使用长度前缀风格（s:<len>:<text> /
 *   n:<number> / b:<bool> / n:null），无 undefined/NaN 静默碰撞；
 * - **拒绝集合**（结构化拒绝，绝不抛出中断 tick）：cyclic（祖先栈检测）、
 *   accessor 属性（descriptor 检测先于读取——getter 零副作用读取）、非普通
 *   prototype（Object.prototype/Array.prototype 之外——涵盖 class instance/
 *   Date/Map/Set）、function/symbol/bigint/undefined/NaN/±Infinity、symbol
 *   键（静默丢弃不可接受）、稀疏数组（hole 检测）、非普通对象；
 * - **有界**：深度 ≤ 16、编码文本 ≤ 4096 字符、数组长度 ≤ 256、对象自有键
 *   ≤ 64——超限结构化拒绝（contract args 必须小而确定）。
 */

export const TREASURY_CANONICAL_ENCODING_VERSION = 2 as const;

export const TREASURY_CANONICAL_MAX_DEPTH = 16;
export const TREASURY_CANONICAL_MAX_TEXT_LENGTH = 4096;
export const TREASURY_CANONICAL_MAX_ARRAY_LENGTH = 256;
export const TREASURY_CANONICAL_MAX_OBJECT_KEYS = 64;

export type TreasuryCanonicalizationResult =
  | { readonly status: "ok"; readonly canonical: unknown; readonly text: string }
  | { readonly status: "rejected"; readonly detail: string };

function isPlainObjectPrototype(value: object): boolean {
  return Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * 有界异常描述（反射故障诊断——绝不持久化完整 Error/stack）。
 */
function boundedFaultDetail(error: unknown, op: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return `reflection_fault(${op}): ${message.slice(0, 96)}`;
}

/** 数组/对象复合分支（ancestors 已由调用方维护；反射异常由外层统一边界捕获）。 */
function canonicalizeComposite(
  value: object,
  ancestors: object[],
  depth: number,
): { status: "ok"; canonical: unknown; text: string } | { status: "rejected"; detail: string } {
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      return { status: "rejected" as const, detail: "数组 prototype 非法（子类/代理一律拒绝）" };
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return { status: "rejected" as const, detail: "数组不得携带 symbol 键" };
    }
    const ownKeys = Object.keys(value);
    if (ownKeys.length !== value.length) {
      return { status: "rejected" as const, detail: "稀疏数组不允许（hole 语义不确定）" };
    }
    if (value.length > TREASURY_CANONICAL_MAX_ARRAY_LENGTH) {
      return { status: "rejected" as const, detail: `数组长度超过上限 ${String(TREASURY_CANONICAL_MAX_ARRAY_LENGTH)}` };
    }
    const canonicalItems: unknown[] = [];
    const parts: string[] = [];
    let index = 0;
    for (const item of value) {
      // 数组迭代（iterator trap）逐元素防护（第十轮 3.12.12）。
      try {
        const encoded = canonicalize(item, ancestors, depth + 1);
        if (encoded.status === "rejected") return { status: "rejected" as const, detail: `数组元素非法: ${encoded.detail}` };
        canonicalItems.push(encoded.canonical);
        parts.push(encoded.text);
      } catch (error) {
        return { status: "rejected" as const, detail: boundedFaultDetail(error, `array_iterate[${String(index)}]`) };
      }
      index += 1;
    }
    const text = `a:${String(value.length)}[${parts.join("")}]`;
    return { status: "ok" as const, canonical: Object.freeze(canonicalItems), text };
  }
  if (!isPlainObjectPrototype(value)) {
    return { status: "rejected" as const, detail: "非普通对象不允许（class instance/Date/Map/Set 等——prototype 非法）" };
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return { status: "rejected" as const, detail: "对象不得携带 symbol 键（静默丢弃不可接受）" };
  }
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length > TREASURY_CANONICAL_MAX_OBJECT_KEYS) {
    return { status: "rejected" as const, detail: `对象自有键超过上限 ${String(TREASURY_CANONICAL_MAX_OBJECT_KEYS)}` };
  }
  const record = value as Record<string, unknown>;
  // accessor 检测先于值读取（getter 零副作用读取——多次读取产生不同值的
  // 对象在源头拒绝；descriptor trap 异常由统一边界捕获）。
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      return { status: "rejected" as const, detail: `accessor 属性不允许（key ${key.slice(0, 32)}）` };
    }
  }
  const sortedKeys = [...keys].sort();
  const canonicalRecord: Record<string, unknown> = {};
  const parts: string[] = [];
  for (const key of sortedKeys) {
    // 属性值读取（get trap）逐属性防护（第十轮 3.12.12）。
    let encoded: { status: "ok"; canonical: unknown; text: string } | { status: "rejected"; detail: string };
    try {
      encoded = canonicalize(record[key], ancestors, depth + 1);
    } catch (error) {
      return { status: "rejected" as const, detail: boundedFaultDetail(error, `read_property[${key.slice(0, 32)}]`) };
    }
    if (encoded.status === "rejected") return { status: "rejected" as const, detail: `属性 ${key.slice(0, 32)} 非法: ${encoded.detail}` };
    canonicalRecord[key] = encoded.canonical;
    parts.push(`s:${String(key.length)}:${key}:${encoded.text}`);
  }
  const text = `o:${String(sortedKeys.length)}{${parts.join("")}}`;
  return { status: "ok" as const, canonical: Object.freeze(canonicalRecord), text };
}

/**
 * 递归 canonicalize：返回 [冻结深拷贝, 确定性文本] 或拒绝描述。
 * ancestors 为当前路径上的对象栈（cyclic 检测）；拒绝时绝不产生部分副作用。
 * canonicalize 自身不调用任何外部函数（getter/symbol 键在源头拒绝）——
 * 正常路径无异常，ancestors 在复合分支结束后对称弹出。
 */
function canonicalize(
  value: unknown,
  ancestors: object[],
  depth: number,
): { status: "ok"; canonical: unknown; text: string } | { status: "rejected"; detail: string } {
  if (value === null) return { status: "ok" as const, canonical: null, text: "n:null" };
  const type = typeof value;
  if (type === "boolean") return { status: "ok" as const, canonical: value, text: `b:${String(value)}` };
  if (type === "number") {
    if (Number.isNaN(value)) return { status: "rejected" as const, detail: "NaN 不允许出现在 canonical args（与 null 静默碰撞）" };
    if (value === Number.POSITIVE_INFINITY || value === Number.NEGATIVE_INFINITY) {
      return { status: "rejected" as const, detail: "±Infinity 不允许出现在 canonical args" };
    }
    // -0 与 0 在 String() 下碰撞——Object.is 区分（语义上 -0 可辨）。
    const text = Object.is(value, -0) ? "n:-0" : `n:${String(value)}`;
    return { status: "ok" as const, canonical: value, text };
  }
  if (typeof value === "string") return { status: "ok" as const, canonical: value, text: `s:${String(value.length)}:${value}` };
  if (type === "undefined") return { status: "rejected" as const, detail: "undefined 不允许出现在 canonical args（与缺省键静默碰撞）" };
  if (type === "function") return { status: "rejected" as const, detail: "function 不允许出现在 canonical args" };
  if (type === "symbol") return { status: "rejected" as const, detail: "symbol 不允许出现在 canonical args" };
  if (type === "bigint") return { status: "rejected" as const, detail: "bigint 不允许出现在 canonical args（无明确编码）" };
  // typeof === "object"
  if (typeof value !== "object" || value === null) {
    return { status: "rejected" as const, detail: `未知值类型: ${String(type)}` };
  }
  if (depth >= TREASURY_CANONICAL_MAX_DEPTH) {
    return { status: "rejected" as const, detail: `canonical args 深度超过上限 ${String(TREASURY_CANONICAL_MAX_DEPTH)}` };
  }
  if (ancestors.includes(value)) {
    return { status: "rejected" as const, detail: "cyclic 结构不允许出现在 canonical args" };
  }
  ancestors.push(value);
  let outcome: { status: "ok"; canonical: unknown; text: string } | { status: "rejected"; detail: string };
  try {
    outcome = canonicalizeComposite(value, ancestors, depth);
  } finally {
    // 对称弹出（异常路径也恢复栈——反射 trap 抛错时 ancestors 不残留）。
    ancestors.pop();
  }
  return outcome;
}

/**
 * canonicalize action args（actionContracts 的唯一编码入口）。
 * 返回冻结深拷贝（canonical frozen args）与确定性文本；任何非法输入结构化
 * 拒绝（零抛出）。
 */
export function canonicalizeTreasuryActionArgs(args: unknown): TreasuryCanonicalizationResult {
  // 统一反射异常边界（第十轮 3.12.12）：revoked Proxy / throwing ownKeys /
  // getPrototypeOf / getOwnPropertyDescriptor / get trap 一律结构化拒绝
  //（reflection_fault——不抛出、不中断 tick）；getter 仍零调用（descriptor
  // 检查先于任何值读取）。
  let encoded: { status: "ok"; canonical: unknown; text: string } | { status: "rejected"; detail: string };
  try {
    encoded = canonicalize(args, [], 0);
  } catch (error) {
    return { status: "rejected", detail: boundedFaultDetail(error, "canonicalize") };
  }
  if (encoded.status === "rejected") {
    return { status: "rejected", detail: encoded.detail };
  }
  if (encoded.text.length > TREASURY_CANONICAL_MAX_TEXT_LENGTH) {
    return {
      status: "rejected",
      detail: `canonical args 编码超过上限 ${String(TREASURY_CANONICAL_MAX_TEXT_LENGTH)}（实际 ${String(encoded.text.length)}）`,
    };
  }
  return { status: "ok", canonical: encoded.canonical, text: encoded.text };
}
