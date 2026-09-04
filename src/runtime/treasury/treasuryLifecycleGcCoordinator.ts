/**
 * 【Round 22 Remediation IX 工作流 B / 5.2】单一 lifecycle GC coordinator。
 *
 * beginTick 以固定条目预算执行有界 GC（query 路径零写）：
 * 1. active issued ticket 的显式过期（TTL → expired——正面生命周期事实，
 *    不是删除，也不是"猜测调用方放弃"）；
 * 2. terminal（consumed/expired）ticket 的有界淘汰（每批 ≤8——淘汰前验证
 *    issuer watermark frontier 已承载 sequence anti-reuse）；
 * 3. ticket store unhealthy → 本 tick 跳过 GC（不把"读不到"当成可清理）。
 *
 * recent exact detail queue（summary/certificate/historical/completion）的
 * 淡载主动滚动不在此处强制执行——它们的淘汰在写入路径满载时按 lifecycle
 * contract 的 replacement 验证触发（eviction eligibility 由生命周期状态决
 * 定，不只由年龄决定；Q1-Q9 固定反例覆盖）；本 coordinator 不做任何无
 * replacement 验证的删除。
 */

import {
  expireTreasuryIssuedAttemptTickets,
  peekTreasuryIssuedAttemptTicketHealth,
  retireTreasuryTerminalIssuedAttemptTickets,
} from "@/runtime/treasury/attemptIssuanceTicket";
import { peekTreasuryIssuedAttemptWatermark } from "@/runtime/treasury/attemptIssuer";

export interface TreasuryLifecycleGcReport {
  /** active → expired 的显式转换数。 */
  readonly ticketsExpired: number;
  /** terminal ticket 淘汰数（watermark frontier 验证后）。 */
  readonly ticketsRetired: number;
  /** null = 正常；字符串 = 本 tick 跳过原因（store unhealthy 等）。 */
  readonly skipped: string | null;
}

/**
 * beginTick 的固定预算 lifecycle GC（幂等；每 tick 有界）。
 * 返回结构化报告——失败不写成"已清理"。
 */
export function runTreasuryLifecycleGcCoordinator(): TreasuryLifecycleGcReport {
  const ticketHealth = peekTreasuryIssuedAttemptTicketHealth();
  if (!ticketHealth.healthy) {
    return { ticketsExpired: 0, ticketsRetired: 0, skipped: `issued ticket store unhealthy: ${ticketHealth.detail}（GC 跳过——fail closed）` };
  }
  const ticketsExpired = expireTreasuryIssuedAttemptTickets();
  const watermark = peekTreasuryIssuedAttemptWatermark();
  if (watermark < 0) {
    return { ticketsExpired, ticketsRetired: 0, skipped: "issuer watermark 不可读（terminal ticket 淘汰跳过——fail closed）" };
  }
  const retirement = retireTreasuryTerminalIssuedAttemptTickets(watermark);
  return {
    ticketsExpired,
    ticketsRetired: retirement.retired,
    skipped: retirement.detail,
  };
}
