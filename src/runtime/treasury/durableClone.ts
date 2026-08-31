/**
 * 【第十六轮第十节】authority 写入候选的输入别名隔离帮助模块。
 *
 * 背景：intent / quarantine / authorization-fault / resolution tombstone /
 * write-fault marker 的写入路径此前对嵌套可变对象（authorizationCohort 的
 * revisions 与 authorization leg digests、structureFacts、forensic detail、
 * attemptIdentity 等）保留调用方引用——调用方在写入成功后原地修改输入对象
 * 即可污染 Memory 权威副本（read-back 校验发生在写入当下，无法拦截后续
 * 变更）。
 *
 * 本模块提供唯一的 bounded durable clone helper（写入侧；读取侧快照见
 * durableSnapshot.treasuryBoundedDeepFreezeSnapshot）：
 * - 只处理**明确有界**的普通对象与数组（深度上限 + 每层键数上限）；
 * - 逐层深拷贝且**不冻结**（Memory 副本仍需可被后续受控写入更新）；
 * - 超出深度/键数上限时该层退化为浅拷贝（fail safe，不无限递归，也不抛出
 *   中断 tick）；
 * - 不处理 class instance / 函数等非普通值（原样复制标量语义）。
 *
 * 发布顺序（各 store 写入口统一遵守）：clone 输入 → 验证 clone → 重算
 * clone identity → Memory 写入 clone → read-back 验证。绝不把调用方原对象
 * 写入 Memory 后再对返回快照冻结。
 */

const TREASURY_DURABLE_CLONE_MAX_DEPTH = 8;
const TREASURY_DURABLE_CLONE_MAX_KEYS = 256;

function cloneValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= TREASURY_DURABLE_CLONE_MAX_DEPTH) {
    // 超出深度：浅拷贝兜底（嵌套一层不可变标量字段语义保留；不再递归）。
    return Array.isArray(value) ? [...value] : { ...(value as Record<string, unknown>) };
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item, depth + 1));
  }
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length > TREASURY_DURABLE_CLONE_MAX_KEYS) {
    return { ...source };
  }
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    copy[key] = cloneValue(source[key], depth + 1);
  }
  return copy;
}

/**
 * 有界深拷贝（写入侧专用）：返回值与调用方输入在任何嵌套层级都不共享可变
 * 引用——写入成功后调用方修改原输入不会影响 Memory 权威副本。支持明确
 * schema 中的普通对象、数组、嵌套 revisions、authorization leg digests、
 * structure descriptors、forensic provenance 与 attemptIdentity。
 */
export function cloneTreasuryDurableValue<T>(value: T): T {
  return cloneValue(value, 0) as T;
}
