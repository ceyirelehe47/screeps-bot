/**
 * 【Round 22 Remediation IX 工作流 B / 5.2】单一 lifecycle GC coordinator。
 *
 * beginTick 以固定条目预算执行有界 GC（query 路径零写）：
 * 0. 【XI 工作流 E】v1 retired range store 的显式 tick-boundary 迁移
 *    （唯一 migration owner——query 只报告 migration_required，绝不迁移）：
 *    v1 源形状校验 → 发行域严格证明（不可证明 → blocked，原数据保留）→
 *    单对象替换 + Memory read-back；幂等（v2/absent → idle 零写）；
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
import { migrateLegacyRetiredRangeStore } from "@/runtime/treasury/chainRetirementCertificate";

/**
 * 【XI 工作流 E / M3-M6】v1 retired range 迁移报告（tick-boundary
 * migration owner 的结构化结果——失败不折叠为 ordinary absent）。
 */
export interface TreasuryRetiredRangeMigrationReport {
  /** idle = v2/absent（零写）；migrated = 本次完成迁移；blocked = 不可证明（原 v1 保留）；unhealthy = 源损坏/版本未知。 */
  readonly status: "idle" | "migrated" | "blocked" | "unhealthy";
  readonly detail: string | null;
}

/**
 * v1 retired range 的显式迁移（唯一 migration owner——beginTick 的前置
 * migration 阶段）。幂等（v2/absent → idle，零写）；迁移前 v1 源完整形状
 * 校验 + 发行域严格证明（issuer 版本边界），不可证明 → blocked（原 store
 * 原样保留，query 与 absorb 继续 fail closed，不产生第二 frontier）。
 */
export function runTreasuryRetiredRangeMigrationAtTickBoundary(): TreasuryRetiredRangeMigrationReport {
  const raw = (Memory.runtime as unknown as { treasury?: { retiredAttemptRanges?: { version?: unknown } } } | undefined)
    ?.treasury?.retiredAttemptRanges;
  if (raw === undefined) return { status: "idle", detail: null };
  if (raw.version === 2) return { status: "idle", detail: null };
  if (raw.version !== 1) {
    return {
      status: "unhealthy",
      detail: `retired range store 版本未知（${String(raw.version).slice(0, 8)}——不迁移，fail closed）`,
    };
  }
  const runtime = migrateLegacyRetiredRangeStore(raw);
  if (runtime.fatal !== null) {
    return { status: "blocked", detail: runtime.fatal };
  }
  return { status: "migrated", detail: null };
}

export interface TreasuryLifecycleGcReport {
  /** active → expired 的显式转换数。 */
  readonly ticketsExpired: number;
  /** terminal ticket 淘汰数（watermark frontier 验证后）。 */
  readonly ticketsRetired: number;
  /** null = 正常；字符串 = 本 tick 跳过原因（store unhealthy 等）。 */
  readonly skipped: string | null;
  /** 【XI 工作流 E】v1 retired range 迁移阶段结果（前置——blocked/unhealthy 不阻断 ticket GC）。 */
  readonly rangeMigration: TreasuryRetiredRangeMigrationReport;
}

/**
 * beginTick 的固定预算 lifecycle GC（幂等；每 tick 有界）。
 * 返回结构化报告——失败不写成"已清理"。
 */
export function runTreasuryLifecycleGcCoordinator(): TreasuryLifecycleGcReport {
  // 【XI 工作流 E】前置 migration 阶段（唯一 owner）：v1 → v2 显式迁移。
  // blocked/unhealthy 只报告（原数据保留）；不阻断后续 ticket GC（互不
  // 依赖的 store）。
  const rangeMigration = runTreasuryRetiredRangeMigrationAtTickBoundary();
  const ticketHealth = peekTreasuryIssuedAttemptTicketHealth();
  if (!ticketHealth.healthy) {
    return {
      ticketsExpired: 0,
      ticketsRetired: 0,
      skipped: `issued ticket store unhealthy: ${ticketHealth.detail}（GC 跳过——fail closed）`,
      rangeMigration,
    };
  }
  const ticketsExpired = expireTreasuryIssuedAttemptTickets();
  const watermark = peekTreasuryIssuedAttemptWatermark();
  if (watermark < 0) {
    return {
      ticketsExpired,
      ticketsRetired: 0,
      skipped: "issuer watermark 不可读（terminal ticket 淘汰跳过——fail closed）",
      rangeMigration,
    };
  }
  const retirement = retireTreasuryTerminalIssuedAttemptTickets(watermark);
  return {
    ticketsExpired,
    ticketsRetired: retirement.retired,
    skipped: retirement.detail,
    rangeMigration,
  };
}
