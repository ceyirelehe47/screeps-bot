/**
 * 【第十八轮 24.12】adapter 显式 retry semantic facts 协议。
 *
 * 背景：Round 17 的 retry digest 依赖 adapterRegistrationId（per-global 注册
 * 序号——注册顺序变化/global reset 后 digest 漂移，合法 rearm 被误拒），且
 * durable reconciliation payload 对"覆盖全部真实 Game API 调用语义参数"只是
 * 隐式假设。
 *
 * 固定语义：
 * - 可 rearm 的 adapter 必须显式声明 `retryFacts(args)`：从 canonical frozen
 *   args 派生有界事实对象（string/number/boolean 值），与 durableFacts 职责
 *   分离——**必须覆盖全部会改变真实 Game API 调用语义的参数**（资源/数量/
 *   源目标/费用/方式等）；
 * - 输出经共享边界：shape validation（plain object、键 ≤48 字符且 ≤32 个、
 *   值 string ≤128 / number 安全 / boolean）、canonical encoding（键排序 +
 *   类型标签 + 长度前缀——s:<len>:<text> / n:<num> / b:0|1）、总长上限
 *   1024 字符、异常边界（调用抛错 → 调用侧 fail closed，不产出部分事实）；
 * - adapter 未实现 retryFacts：action 正常执行；not-executed 后只能
 *   non-rearmable（不猜测——digest 不可重建）；
 * - retry facts 语义变化时 adapter 必须提升 retry semantic 版本（digest 协议
 *   tag v2 参与编码——旧 capability 绑定的 digest 自动失效）。
 */

/** canonical retry facts 的有界文本（intent/quarantine 持久化 + digest 输入）。 */
export const TREASURY_ADAPTER_RETRY_FACTS_MAX_KEYS = 32;
export const TREASURY_ADAPTER_RETRY_FACTS_KEY_MAX = 48;
export const TREASURY_ADAPTER_RETRY_FACTS_STRING_MAX = 128;
export const TREASURY_ADAPTER_RETRY_FACTS_CANONICAL_MAX = 1024;

/** adapter retryFacts 的输出形状（受限 Record）。 */
export type TreasuryAdapterRetryFacts = Readonly<Record<string, string | number | boolean>>;

export type TreasuryAdapterRetryFactsCanonicalization =
  | { readonly status: "canonicalized"; readonly text: string }
  | { readonly status: "rejected"; readonly detail: string };

function encodeRetryFactValue(value: string | number | boolean): string {
  if (typeof value === "boolean") return `b:${value ? "1" : "0"}`;
  if (typeof value === "number") return `n:${String(value)}`;
  return `s:${String(value.length)}:${value}`;
}

/**
 * canonicalize + 边界校验（contract build / 权威比较共用）：任何形状/大小
 * 违规 → rejected（fail closed——不猜测、不截断）。
 */
export function canonicalizeTreasuryAdapterRetryFacts(facts: unknown): TreasuryAdapterRetryFactsCanonicalization {
  if (facts === null || facts === undefined) {
    return { status: "rejected", detail: "retry facts 为 null/undefined（未实现——non-rearmable）" };
  }
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) {
    return { status: "rejected", detail: "retry facts 非普通对象" };
  }
  const entries = Object.entries(facts as Record<string, unknown>);
  if (entries.length === 0) {
    return { status: "rejected", detail: "retry facts 为空对象（无事实即无法证明语义重试）" };
  }
  if (entries.length > TREASURY_ADAPTER_RETRY_FACTS_MAX_KEYS) {
    return { status: "rejected", detail: `retry facts 键数超上限（${String(entries.length)} > ${String(TREASURY_ADAPTER_RETRY_FACTS_MAX_KEYS)}）` };
  }
  const parts: string[] = [];
  for (const [key, value] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (typeof key !== "string" || key.length === 0 || key.length > TREASURY_ADAPTER_RETRY_FACTS_KEY_MAX) {
      return { status: "rejected", detail: `retry facts 键非法（1..${String(TREASURY_ADAPTER_RETRY_FACTS_KEY_MAX)} 字符）: ${key.slice(0, 24)}` };
    }
    if (typeof value === "number" && (!Number.isSafeInteger(value))) {
      return { status: "rejected", detail: `retry facts 数值非安全整数（键 ${key.slice(0, 16)}）` };
    }
    if (typeof value === "string" && value.length > TREASURY_ADAPTER_RETRY_FACTS_STRING_MAX) {
      return { status: "rejected", detail: `retry facts 字符串超上限（键 ${key.slice(0, 16)}）` };
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return { status: "rejected", detail: `retry facts 值类型非法（键 ${key.slice(0, 16)}——只允许 string/number/boolean）` };
    }
    parts.push(`${String(key.length)}:${key}=${encodeRetryFactValue(value)}`);
  }
  const text = `rfv1:${parts.join("|")}`;
  if (text.length > TREASURY_ADAPTER_RETRY_FACTS_CANONICAL_MAX) {
    return { status: "rejected", detail: `retry facts canonical 编码超上限（${String(text.length)} > ${String(TREASURY_ADAPTER_RETRY_FACTS_CANONICAL_MAX)}）` };
  }
  return { status: "canonicalized", text };
}
