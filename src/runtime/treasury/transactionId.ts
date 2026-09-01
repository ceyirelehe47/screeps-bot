/**
 * Treasury transactionId 规范与铸造——canonical hashed identity（v2）。
 *
 * 幂等 receipt 的可靠性依赖 id 的全局唯一性。Treasury 边界强制：
 * - 长度 1..128；
 * - 字符集限定 [A-Za-z0-9:_\-.]（可打印、无空白、JSON/日志安全）；
 * - 存量兼容：validator 不变——历史 receipt store 中的旧格式 id（如
 *   `seed:100000:0`、`abc`、`__proto__`）继续合法，绝不允许因铸造侧升级
 *   把存量 store 判损坏。
 *
 * 铸造（v2 重做）：不再拼接业务字段原文，改为 canonical tuple 序列化 +
 * 稳定 hash 定长输出：
 * - canonical 编码：每成分 `s:<len>:<原文>`（字符串，len 为 UTF-16 code
 *   unit 数）/ `n:<数字>`（非负安全整数），版本头 `V2`——类型标签区分
 *   number 42 与 string "42"，长度前缀消除元组边界歧义（`("a:b","c")`
 *   与 `("a","b:c")` 编码不同），字段顺序、空字符串、Unicode、空格、
 *   冒号均可作为业务字段输入；
 * - 稳定 hash：双 lane FNV-1a 32 位（第二 lane 种子由第一 lane 结果
 *   扰动派生），64 位空间、纯函数、无随机数，相同输入跨 tick 恒定；
 * - 命名空间隔离：stable（`ts1_<hash16>`）与 per-tick（`tt1_<tick>_
 *   <hash16>`）使用不同且不可重叠的前缀——同一 tuple 在两个命名空间
 *   永不碰撞；超长业务字段仍产出固定长度（≤128）合法 id；
 * - prepare 幂等/digest 复用同一 hash 核（hashTreasuryCanonicalString）。
 *
 * 入口语义（沿袭 v1）：
 * - formatTreasuryStableTransactionId——同一业务动作（同订单/同结构/同
 *   业务自然键）跨 tick 重试铸造出相同 id，receipt 幂等跨 tick 生效；
 * - formatTreasuryTransactionId——`${tick}` 参与 canonical tuple，仅适用
 *   于"每 tick 天然只发生一次的新动作"；跨 tick 重试禁止使用。
 */

export const TREASURY_TRANSACTION_ID_MAX_LENGTH = 128;

const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9:_\-.]{1,128}$/;

/** stable 命名空间前缀（per-tick 前缀不同，二者不可重叠）。 */
const STABLE_ID_PREFIX = "ts1_";
/** per-tick 命名空间前缀。 */
const TICK_ID_PREFIX = "tt1_";
const REARM_ID_PREFIX = "tr1_";
/**
 * 【第十七轮第八节】Treasury 保留的 rearm attempt 命名空间前缀（单一
 * 权威）：任何 production tr1_ ID 都必须绑定匹配的 service-issued opaque
 * rearm capability——手工拼接/公开 hash/普通字符串不可绕过。
 */
export const TREASURY_REARM_ID_PREFIX = REARM_ID_PREFIX;
/** canonical 编码版本头（格式升级时递增，保证新旧编码不碰撞）。 */
const CANONICAL_VERSION_HEAD = "V2";

export function isValidTreasuryTransactionId(transactionId: string): boolean {
  return typeof transactionId === "string" && TRANSACTION_ID_PATTERN.test(transactionId);
}

/** 【第十七轮第八节】tr1_ 保留命名空间判定的唯一权威实现。 */
export function isTreasuryRearmAttemptId(transactionId: string): boolean {
  return typeof transactionId === "string" && transactionId.startsWith(REARM_ID_PREFIX);
}

/**
 * 【第十八轮 14.4】generation-addressable rearm child ID（协议 v2）：
 * `tr1_<lineageId:16hex>_<generation:6hex>_<checksum:8hex>`——ID 自带
 * (lineageId, generation)，可 O(1) 解析；checksum 绑定 root transactionId
 * （对 record 重算即可验证 ID 确属该 chain）。同 lineage+generation 恒同一
 * ID（每代唯一 child 由 lineage 状态机保证）；不同 lineage/generation 必不
 * 同。旧 v1 child ID（parent identity 派生，20 字符）不匹配本形态 → 不可
 * 寻址（legacy 隔离：继续受 tr1_ 门禁，但不得猜测 generation）。
 */
const REARM_CHILD_V2_PATTERN = /^tr1_([0-9a-f]{16})_([0-9a-f]{6})_([0-9a-f]{8})$/;

/** v2 child ID 的派生协议标签（协议升级时递增）。 */
export const TREASURY_REARM_CHILD_ID_PROTOCOL_V2 = "treasury-attempt-rearm@v2";

function toHex6(value: number): string {
  return (value >>> 0).toString(16).padStart(6, "0");
}

/** 铸造 generation-addressable rearm child ID（attemptLineage 单一调用点）。 */
export function formatTreasuryRearmChildTransactionIdV2(input: {
  readonly lineageId: string;
  readonly generation: number;
  readonly rootTransactionId: string;
}): string {
  if (
    typeof input.lineageId !== "string" ||
    !/^[0-9a-f]{16}$/.test(input.lineageId) ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1 ||
    input.generation > 0xffffff
  ) {
    throw new Error(`rearm child ID v2 铸造输入非法: ${JSON.stringify(input).slice(0, 96)}`);
  }
  const checksum = hashTreasuryCanonicalString(
    `${TREASURY_REARM_CHILD_ID_PROTOCOL_V2}:${input.lineageId}:${String(input.generation)}:${input.rootTransactionId}`,
  );
  const childId = `${REARM_ID_PREFIX}${input.lineageId}_${toHex6(input.generation)}_${checksum.slice(0, 8)}`;
  if (!isValidTreasuryTransactionId(childId)) {
    throw new Error(`rearm child ID v2 铸造结果不符合 Treasury transactionId 边界: ${childId}`);
  }
  return childId;
}

/**
 * 解析 v2 rearm child ID（只认完整 v2 形态；v1/伪造 ID 返回 null——不猜测）。
 * 不验证 checksum（需要 root 与 lineage record 对照，由调用侧权威完成）。
 */
export function parseTreasuryRearmChildTransactionIdV2(
  transactionId: string,
): { readonly lineageId: string; readonly generation: number } | null {
  if (typeof transactionId !== "string") return null;
  const match = REARM_CHILD_V2_PATTERN.exec(transactionId);
  if (match === null) return null;
  const generation = Number.parseInt(match[2], 16);
  if (!Number.isSafeInteger(generation) || generation < 1) return null;
  return { lineageId: match[1], generation };
}

/** v2 child ID 的 checksum 成分重算（record 对照验证共用）。 */
export function treasuryRearmChildIdChecksumOf(input: {
  readonly lineageId: string;
  readonly generation: number;
  readonly rootTransactionId: string;
}): string {
  return hashTreasuryCanonicalString(
    `${TREASURY_REARM_CHILD_ID_PROTOCOL_V2}:${input.lineageId}:${String(input.generation)}:${input.rootTransactionId}`,
  ).slice(0, 8);
}

/**
 * 单个 canonical 成分编码（类型标签 + 长度前缀 / 数字直写）：
 * - 字符串 `s:<len>:<原文>`——任意 Unicode/空串/空格/冒号合法，len 为
 *   code unit 数，消费方按 len 精确切分，编码对拼接可逆（无元组边界歧义）；
 * - 数字 `n:<十进制>`——必须为非负安全整数（attempt sequence 等业务序号）。
 */
function encodeComponent(component: string | number, index: number): string {
  if (typeof component === "number") {
    if (!Number.isInteger(component) || !Number.isSafeInteger(component) || component < 0) {
      throw new Error(`transactionId 成分 #${index} 非法数字（须为非负安全整数）: ${String(component)}`);
    }
    return `n:${String(component)}`;
  }
  if (typeof component !== "string") {
    throw new Error(`transactionId 成分 #${index} 非法（string | number）: ${String(component)}`);
  }
  return `s:${String(component.length)}:${component}`;
}

/**
 * canonical tuple 序列化：`V2` + 全部成分编码顺序拼接。编码前缀无关
 * （类型标签决定解析入口、长度前缀决定字符串边界），拼接结果与成分
 * 序列一一对应——`("a:b","c")`、`("a","b:c")`、`("a:","bc")`、
 * `("a",42)` 与 `("a","42")` 互不相同。
 */
export function encodeTreasuryCanonicalTuple(components: ReadonlyArray<string | number>): string {
  let encoded = CANONICAL_VERSION_HEAD;
  for (let index = 0; index < components.length; index += 1) {
    encoded += encodeComponent(components[index], index);
  }
  return encoded;
}

function toHex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}

/** FNV-1a 32 位（单 lane；seed 注入使多 lane 之间去相关）。 */
function fnv1a32(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 稳定 64 位 hash（16 个小写 hex）：双 lane FNV-1a——lane1 固定 offset
 * basis；lane2 种子由 lane1 结果乘以去相关常数扰动派生。纯确定性、无
 * 随机数、跨 tick/跨运行环境恒定；64 位空间足以避免普通帝国业务碰撞。
 */
export function hashTreasuryCanonicalString(input: string): string {
  const lane1 = fnv1a32(input, 0x811c9dc5);
  const lane2 = fnv1a32(input, (0x9e3779b9 ^ Math.imul(lane1, 0x85ebca6b)) >>> 0);
  return toHex8(lane1) + toHex8(lane2);
}

/**
 * 铸造 stable transactionId：`ts1_<hash16>`。
 * discriminators 必须是稳定的业务自然键（订单 id/结构 id/业务序号等）：
 * 同一业务动作无论在哪个 tick 重试，canonical tuple 恒相同 → hash 恒
 * 相同 → id 恒相同——首次结算写入 receipt 后，任何 tick 的重放都会命中
 * already_settled。业务字段可为任意字符串（Unicode/空格/冒号/空串）与
 * 非负安全整数；类型与顺序均参与编码。
 */
export function formatTreasuryStableTransactionId(
  kind: string,
  ...discriminators: Array<string | number>
): string {
  return STABLE_ID_PREFIX + hashTreasuryCanonicalString(encodeTreasuryCanonicalTuple([kind, ...discriminators]));
}

/**
 * 铸造 per-tick transactionId：`tt1_<tick>_<hash16>`。
 * Game.time 参与 canonical tuple：跨 tick 唯一性由 tick 分量保证，代价是
 * 重试场景下每次 tick 铸造不同 id——只适用于首笔成功即终态、无跨 tick
 * 重试语义的新动作；跨 tick 重试必须改用 formatTreasuryStableTransactionId。
 * 成分校验与 stable 版一致。
 */
export function formatTreasuryTransactionId(
  kind: string,
  ...discriminators: Array<string | number>
): string {
  const id =
    TICK_ID_PREFIX +
    String(Game.time) +
    "_" +
    hashTreasuryCanonicalString(encodeTreasuryCanonicalTuple([kind, Game.time, ...discriminators]));
  if (!isValidTreasuryTransactionId(id)) {
    throw new Error(`铸造结果不符合 Treasury transactionId 边界: ${id}`);
  }
  return id;
}
