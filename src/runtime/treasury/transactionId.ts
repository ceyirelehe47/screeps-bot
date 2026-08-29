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
 */

export const TREASURY_TRANSACTION_ID_MAX_LENGTH = 128;

const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9:_\-.]{1,128}$/;

export function isValidTreasuryTransactionId(transactionId: string): boolean {
  return typeof transactionId === "string" && TRANSACTION_ID_PATTERN.test(transactionId);
}

/**
 * 铸造稳定 transactionId：`${kind}:${discriminators.join(":")}`（无 tick 前缀）。
 * discriminators 必须是稳定的业务自然键（订单 id/结构 id/业务序号等）：
 * 同一业务动作无论在哪个 tick 重试，铸造结果恒相同——首次结算写入 receipt
 * 后，任何 tick 的重放都会命中 already_settled，幂等保护跨 tick/跨 global
 * reset 生效。自然键不足以保证全局唯一时，禁止使用本 helper。
 */
export function formatTreasuryStableTransactionId(
  kind: string,
  ...discriminators: Array<string | number>
): string {
  return `${kind}:${discriminators.join(":")}`;
}

/**
 * 铸造带 tick 前缀的 transactionId：`${Game.time}:${kind}:${discriminators.join(":")}`。
 * 跨 tick 唯一性由 tick 前缀保证，代价是重试场景下每次 tick 铸造不同 id——
 * 只适用于首笔成功即终态、无跨 tick 重试语义的新动作；跨 tick 重试必须改用
 * formatTreasuryStableTransactionId 或由调用方持久保存首次铸造的 id 复用。
 */
export function formatTreasuryTransactionId(
  kind: string,
  ...discriminators: Array<string | number>
): string {
  return `${Game.time}:${kind}:${discriminators.join(":")}`;
}
