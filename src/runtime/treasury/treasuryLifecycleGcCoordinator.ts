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
  listTreasuryActiveIssuedTicketTransactionIds,
  peekTreasuryIssuedAttemptTicketHealth,
  retireTreasuryTerminalIssuedAttemptTickets,
} from "@/runtime/treasury/attemptIssuanceTicket";
import { peekTreasuryIssuedAttemptWatermark, migrateTreasuryAttemptIssuerStoreLegacyAtTickBoundary } from "@/runtime/treasury/attemptIssuer";
import { completeTreasuryIssuedTicketHandoffForIntentRecovery } from "@/runtime/treasury/attemptIssuanceHandoff";
import { migrateLegacyRetiredRangeStore } from "@/runtime/treasury/chainRetirementCertificate";
import { migrateTreasuryLineageStoreLegacyAtTickBoundary } from "@/runtime/treasury/attemptLineage";
import { migrateTreasuryRetirementSummaryStoreLegacyAtTickBoundary } from "@/runtime/treasury/lineageRetirementSummary";
import { migrateTreasuryGenerationRetirementStoreLegacyAtTickBoundary } from "@/runtime/treasury/generationRetirementAuthority";

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
  /** 【XII 工作流 D / Q7】authority store legacy 版本迁移阶段结果（beginTick 最前置）。 */
  readonly authorityMigration: TreasuryAuthorityStoreMigrationReport;
  /** 【XII 工作流 B / 5.3】execution-owner ticket handoff 收敛数（quarantine owner 在位的 active ticket 幂等 consume）。 */
  readonly ticketHandoffConverged: number;
}

/**
 * 【XII 工作流 D / Q7】authority store legacy 版本的显式迁移（唯一
 * migration owner——beginTick 最前置阶段，先于一切 lineage/intent 恢复）。
 * lineage / retirement summary / GRA 三个 store 的读路径（query）遇 legacy
 * 版本 fail closed（migration_required）且零写；本函数按写路径语义执行
 * 确定性迁移（原子替换 + 全量重验）。幂等（当前版本/absent → idle 零写）；
 * 失败 → blocked（原数据保留，读路径继续 fail closed，下 tick 重试）。
 */
export interface TreasuryAuthorityStoreMigrationReport {
  readonly lineage: { readonly status: "idle" | "migrated" | "blocked"; readonly detail: string | null };
  readonly summary: { readonly status: "idle" | "migrated" | "blocked"; readonly detail: string | null };
  readonly generationRetirement: { readonly status: "idle" | "migrated" | "blocked"; readonly detail: string | null };
  readonly attemptIssuer: { readonly status: "idle" | "migrated" | "blocked"; readonly detail: string | null };
}

export function runTreasuryAuthorityStoreMigrationsAtTickBoundary(): TreasuryAuthorityStoreMigrationReport {
  return {
    lineage: migrateTreasuryLineageStoreLegacyAtTickBoundary(),
    summary: migrateTreasuryRetirementSummaryStoreLegacyAtTickBoundary(),
    generationRetirement: migrateTreasuryGenerationRetirementStoreLegacyAtTickBoundary(),
    attemptIssuer: migrateTreasuryAttemptIssuerStoreLegacyAtTickBoundary(),
  };
}

/**
 * beginTick 的固定预算 lifecycle GC（幂等；每 tick 有界）。
 * 返回结构化报告——失败不写成"已清理"。
 */
export function runTreasuryLifecycleGcCoordinator(): TreasuryLifecycleGcReport {
  // 【XII 工作流 D / Q7】authority store legacy 迁移（唯一 owner；facade
  // beginTick 在恢复逻辑之前已单独调用 runTreasuryAuthorityStoreMigrations-
  // AtTickBoundary——此处幂等复查，保证直接调用本 coordinator 的路径同样覆盖）。
  const authorityMigration = runTreasuryAuthorityStoreMigrationsAtTickBoundary();
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
      authorityMigration,
      ticketHandoffConverged: 0,
    };
  }
  const ticketsExpired = expireTreasuryIssuedAttemptTickets();
  // 【XII 工作流 B / 5.3】ticket handoff 收敛 sweep（有界——active ticket ≤
  // 容量上限）：beginTick 恢复把 execution-owner intent 转 quarantine 时若
  // consume 失败（read-back 抖动等），owner 已转为同 ID quarantine 而 ticket
  // 仍 active——本 sweep 以 quarantine owner（execution-unknown 权威）幂等
  // 补 consume（ForIntentRecovery 内部自验：intent/quarantine 在位 + identity
  // 可构造；不满足即跳过，不误伤普通 active ticket）。
  let ticketHandoffConverged = 0;
  for (const activeId of listTreasuryActiveIssuedTicketTransactionIds()) {
    const converged = completeTreasuryIssuedTicketHandoffForIntentRecovery(activeId);
    if (converged.status === "consumed") ticketHandoffConverged += 1;
  }
  const watermark = peekTreasuryIssuedAttemptWatermark();
  if (watermark < 0) {
    return {
      ticketsExpired,
      ticketsRetired: 0,
      skipped: "issuer watermark 不可读（terminal ticket 淘汰跳过——fail closed）",
      rangeMigration,
      authorityMigration,
      ticketHandoffConverged,
    };
  }
  const retirement = retireTreasuryTerminalIssuedAttemptTickets(watermark);
  return {
    ticketsExpired,
    ticketsRetired: retirement.retired,
    skipped: retirement.detail,
    rangeMigration,
    authorityMigration,
    ticketHandoffConverged,
  };
}
