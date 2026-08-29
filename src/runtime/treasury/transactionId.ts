/**
 * Treasury transactionId 规范与铸造。
 *
 * 幂等 receipt 的可靠性依赖 id 的全局唯一性。Treasury 边界强制：
 * - 长度 1..128；
 * - 字符集限定 [A-Za-z0-9:_\-.]（可打印、无空白、JSON/日志安全）；
 * - 推荐用 formatTreasuryTransactionId 铸造（tick 前缀天然区分 tick，
 *   调用方补充 kind 与业务判别段）。
 */

export const TREASURY_TRANSACTION_ID_MAX_LENGTH = 128;

const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9:_\-.]{1,128}$/;

export function isValidTreasuryTransactionId(transactionId: string): boolean {
  return typeof transactionId === "string" && TRANSACTION_ID_PATTERN.test(transactionId);
}

/**
 * 铸造规范 transactionId：`${Game.time}:${kind}:${discriminators.join(":")}`。
 * discriminators 应包含足够业务判别信息（结构 id/订单 id/序号等）保证同 tick
 * 内唯一；跨 tick 唯一性由 tick 前缀保证。
 */
export function formatTreasuryTransactionId(
  kind: string,
  ...discriminators: Array<string | number>
): string {
  return `${Game.time}:${kind}:${discriminators.join(":")}`;
}
