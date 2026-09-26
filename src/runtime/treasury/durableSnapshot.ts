/**
 * 【第十五轮第十一节】authority 读取快照的有界深冻结帮助模块。
 *
 * 背景：quarantine / authorization-fault 的读取 API 此前只冻结顶层与部分
 * 已知字段——authorizationCohort（含 revisions 与 authorization leg
 * digests）、forensic provenance、structureFacts 等嵌套对象是直接 Memory
 * 引用，调用者原地改写即可污染权威 store 与 heap health cache。
 *
 * 本模块提供唯一的 bounded deep snapshot helper：
 * - 只处理**明确有界**的普通对象与数组（深度上限 + 每层键数上限）；
 * - 每层都拷贝并 Object.freeze——返回快照与 Memory 无任何共享可变引用；
 * - 超出深度/键数上限时该层退化为浅拷贝 + 浅冻结（fail safe，不无限
 *   递归，也不抛出中断 tick）；
 * - 不处理 class instance / 函数等非普通值（原样保留标量语义）。
 */

const TREASURY_SNAPSHOT_MAX_DEPTH = 8;
const TREASURY_SNAPSHOT_MAX_KEYS = 256;

function freezeSnapshotValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= TREASURY_SNAPSHOT_MAX_DEPTH) {
    // 超出深度：浅拷贝 + 浅冻结兜底（嵌套标量字段已不可变；不再递归）。
    return Array.isArray(value) ? Object.freeze([...value]) : Object.freeze({ ...(value as Record<string, unknown>) });
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => freezeSnapshotValue(item, depth + 1)));
  }
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length > TREASURY_SNAPSHOT_MAX_KEYS) {
    return Object.freeze({ ...source });
  }
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    copy[key] = freezeSnapshotValue(source[key], depth + 1);
  }
  return Object.freeze(copy);
}

/**
 * 有界深拷贝 + 深冻结快照：调用者对返回对象的任意嵌套字段写入都不会影响
 * Memory 权威副本（普通对象/数组逐层拷贝冻结；非普通值按标量语义返回）。
 */
export function treasuryBoundedDeepFreezeSnapshot<T>(value: T): Readonly<T> {
  return freezeSnapshotValue(value, 0) as Readonly<T>;
}
