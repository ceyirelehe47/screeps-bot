/**
 * Treasury transactionId 规范与铸造。
 *
 * 幂等 receipt 的可靠性依赖 id 的全局唯一性。Treasury 边界强制：
 * - 长度 1..128；
 * - 字符集限定 [A-Za-z0-9:_\-.]（可打印、无空白、JSON/日志安全）；
 * - 铸造入口二选一：
 *   * formatTreasuryStableTransactionId——不含 tick 前缀，同一业务动作
 *     （同订单/同结构/同业务自然键）跨 tick 重试时铸造出相同 id，receipt
 *     幂等跨 tick 生效；调用方必须保证 discriminators 是稳定的业务自然键；
 *   * formatTreasuryTransactionId——`${Game.time}:...` 前缀，仅适用于
 *     "每 tick 天然只发生一次的新动作"；跨 tick 重试禁止使用（tick 前缀
 *     变化会铸造新 id，导致同一业务动作被二次结算）。
 *
 * 成分防碰撞（第四轮修复）：kind 与每个 discriminator 一律校验为不含
 * 冒号的受限 token——`("a:b","c")` 与 `("a","b:c")` 这类 tuple 边界碰撞、
 * 空串/undefined/NaN 成分、超长或含非法字符的成分一律抛错（fail fast，
 * 调用方 bug 立即暴露，绝不静默铸造出歧义 id）。
 */

export const TREASURY_TRANSACTION_ID_MAX_LENGTH = 128;

const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9:_\-.]{1,128}$/;
/** 铸造成分：不含冒号（join(":") 后可逆，杜绝 tuple 边界碰撞）。 */
const ID_COMPONENT_PATTERN = /^[A-Za-z0-9_\-.]{1,64}$/;

export function isValidTreasuryTransactionId(transactionId: string): boolean {
  return typeof transactionId === "string" && TRANSACTION_ID_PATTERN.test(transactionId);
}

/**
 * 校验并规范化单个铸造成分：字符串必须匹配无冒号 token；数字必须为
 * 非负安全整数。非法成分抛错——铸造入口不得产出歧义/漂移 id。
 */
function assertIdComponent(component: string | number, index: number): string {
  if (typeof component === "number") {
    if (!Number.isInteger(component) || !Number.isSafeInteger(component) || component < 0) {
      throw new Error(`transactionId 成分 #${index} 非法数字: ${String(component)}`);
    }
    return String(component);
  }
  if (typeof component !== "string" || !ID_COMPONENT_PATTERN.test(component)) {
    throw new Error(
      `transactionId 成分 #${index} 非法（须为不含冒号的 [A-Za-z0-9_\\-.]{1,64} token）: ${String(component)}`,
    );
  }
  return component;
}

function assembleId(prefix: string, kind: string, discriminators: ReadonlyArray<string | number>): string {
  if (discriminators.length === 0) {
    throw new Error("transactionId 铸造至少需要一个 discriminator（自然键），禁止裸 kind id");
  }
  const parts = [kind, ...discriminators.map((component, index) => assertIdComponent(component, index + 1))];
  const id = `${prefix}${parts.join(":")}`;
  if (!TRANSACTION_ID_PATTERN.test(id)) {
    throw new Error(`铸造结果不符合 Treasury transactionId 边界: ${id}`);
  }
  return id;
}

/**
 * 铸造稳定 transactionId：`${kind}:${discriminators.join(":")}`（无 tick 前缀）。
 * discriminators 必须是稳定的业务自然键（订单 id/结构 id/业务序号等）：
 * 同一业务动作无论在哪个 tick 重试，铸造结果恒相同——首次结算写入 receipt
 * 后，任何 tick 的重放都会命中 already_settled，幂等保护跨 tick/跨 global
 * reset 生效。自然键不足以保证全局唯一时，禁止使用本 helper。
 * 成分含冒号/空串/非数字等一律抛错（防 tuple 边界碰撞）。
 */
export function formatTreasuryStableTransactionId(
  kind: string,
  ...discriminators: Array<string | number>
): string {
  return assembleId("", assertIdComponent(kind, 0), discriminators);
}

/**
 * 铸造带 tick 前缀的 transactionId：`${Game.time}:${kind}:${discriminators.join(":")}`。
 * 跨 tick 唯一性由 tick 前缀保证，代价是重试场景下每次 tick 铸造不同 id——
 * 只适用于首笔成功即终态、无跨 tick 重试语义的新动作；跨 tick 重试必须改用
 * formatTreasuryStableTransactionId 或由调用方持久保存首次铸造的 id 复用。
 * 成分校验与稳定版一致（非法成分抛错）。
 */
export function formatTreasuryTransactionId(
  kind: string,
  ...discriminators: Array<string | number>
): string {
  return assembleId(`${String(Game.time)}:`, assertIdComponent(kind, 0), discriminators);
}
