/**
 * 【Round 22 Remediation VIII 工作流 D】reservation ↔ completion 的单一
 * handoff owner——prepare acquire / matching publication / 中断恢复 /
 * TTL orphan 判定的统一协议实现。
 *
 * Remediation VII 建立了独占 reservation 与 final admission 前移，但
 * handoff 协议仍散落在 facade / cleanup acknowledgement / beginTick 各自
 * 拼装：completion publication 不要求 matching reservation（live=MAX-1 +
 * reservation=1 时无 reservation 的旧 cleanup 仍可写满最后一个槽）；
 * 写 completion 后、consume 前 global reset 的 matching pair 无恢复通道
 * （双计数滞留至 TTL）；TTL sweep 只看 handle/intent/quarantine，看不到
 * cleanup journal / resolution / fault / marker / lineage。
 *
 * 本模块收敛为单一 owner：
 *
 * 1. **effective occupancy**（D5 容量不变量）：live completion + reserved
 *    - matching pairs——同一 handoff 只计一槽（写 completion 后 consume 前
 *    的中断窗口不产生双计）；
 * 2. **prepare acquire**：用 effective occupancy 判定容量（acquired /
 *    already_reserved / rejected——prepare 的最后一步纯验证失败不遗留
 *    reservation 由调用顺序保证）；
 * 3. **matching publication admission**（D4）：completion 写入前必须存在
 *    matching reservation 且 identity 绑定一致（R8：不一致 → 拒绝发布、
 *    reservation/journal/旧 proof 保留）；无 reservation 的旧 cleanup /
 *    中断恢复 → recovery acquire（容量允许时），无法取得 → journal
 *    pending（不写 completion——R6：不得占用他人槽位）；
 * 4. **beginTick recovery**：matching pair（completion 在位 + reservation
 *    在位）→ 完成 consume（R9：恢复后只剩 completion，不留双计数）；
 *    identity 冲突的 pair 保留（结构化冲突——不 consume 不释放）；
 * 5. **TTL orphan sweep**（D6）：单一 reservation owner state 判定——
 *    active handle 之外的 durable intent / quarantine / cleanup journal /
 *    resolving resolution / authorization fault / write-fault marker /
 *    活跃 lineage / matching live completion 任一在位即 owned（R11）；
 *    任一 owner store unhealthy → 视为 owned（不把"读不到"解释成
 *    orphan——R12 的反面）；全部为空且超 TTL 才释放（R12）。
 */

import {
  lookupTreasuryCleanupCompletion,
  peekTreasuryCleanupCompletionEntryCount,
  peekTreasuryCleanupCompletionHealth,
} from "@/runtime/treasury/cleanupCompletionAuthority";
import {
  acquireTreasuryCompletionHeadroomReservation,
  admitTreasuryCompletionHeadroomReservationForExecution,
  consumeTreasuryCompletionHeadroomReservation,
  peekTreasuryCompletionHeadroomReservation,
  peekTreasuryCompletionHeadroomReservationCount,
  peekTreasuryCompletionHeadroomReservationHealth,
  TREASURY_COMPLETION_RESERVATION_TTL_TICKS,
  type TreasuryCompletionHeadroomReservationEntry,
} from "@/runtime/treasury/completionHeadroomReservation";
import { readTreasuryIntentEntry } from "@/runtime/treasury/intents";
import { readTreasuryQuarantineEntry } from "@/runtime/treasury/quarantine";
import {
  peekTreasuryResolutionCleanupHealth,
  readTreasuryResolutionCleanupEntry,
} from "@/runtime/treasury/resolutionCleanupJournal";
import {
  peekTreasuryAuthorizationFaultHealth,
  readTreasuryAuthorizationFaultEntry,
} from "@/runtime/treasury/authorizationFaults";
import { peekTreasuryWriteFaultHealth, readTreasuryWriteFault } from "@/runtime/treasury/writeFault";
import { reclaimTreasuryCleanupCompletionHeadroom } from "@/runtime/treasury/cleanupCompletionReplacement";

// 【模块环规避】resolutionStore / attemptLineage 在本模块的加载上游
//（cleanupStageAcknowledgement → 本模块 → … 不得回到 resolutionStore 的
// TDZ 初始化区）。owner truth graph 的 tombstone / lineage 维度经 assembly
// 注入（注册方：resolutionStore / attemptLineage 模块加载时——与
// generationRetirementAuthority 的 register 模式同构）。未装配时该维度
// 视为 owned（fail closed——不把"未探测"解释成 orphan）。
interface TreasuryReservationTombstoneProbe {
  readonly tombstoneOf: (transactionId: string) => { readonly stage?: unknown } | undefined;
  readonly tombstoneStoreHealthy: () => boolean;
}

interface TreasuryReservationLineageProbe {
  readonly lineageOf: (transactionId: string) => { readonly state?: unknown } | undefined;
  readonly lineageStoreHealthy: () => boolean;
}

let tombstoneProbe: TreasuryReservationTombstoneProbe | null = null;
let lineageProbe: TreasuryReservationLineageProbe | null = null;

export function registerTreasuryReservationTombstoneProbeForAssembly(probe: TreasuryReservationTombstoneProbe): void {
  tombstoneProbe = probe;
}

export function registerTreasuryReservationLineageProbeForAssembly(probe: TreasuryReservationLineageProbe): void {
  lineageProbe = probe;
}

/** 诊断/测试可见的 mutation 失败计数（checked release 消费——不静默）。 */
export const treasuryCompletionHandoffDiagnostics = {
  releaseFailures: 0,
  consumeFailures: 0,
  recoveryConsumed: 0,
  orphanSwept: 0,
};

export interface TreasuryEffectiveCompletionOccupancy {
  readonly live: number;
  readonly reserved: number;
  /** matching pair 数（live completion 在位且其 reservation 仍在位）。 */
  readonly pairs: number;
  /** live + reserved - pairs（同一 handoff 只计一槽）。 */
  readonly effective: number;
  readonly healthy: boolean;
  readonly detail: string | null;
}

function listTreasuryCompletionReservationEntries(): TreasuryCompletionHeadroomReservationEntry[] {
  const branch = (Memory.runtime as unknown as {
    treasury?: { completionHeadroomReservations?: { entries?: Record<string, TreasuryCompletionHeadroomReservationEntry> } };
  } | undefined)?.treasury?.completionHeadroomReservations;
  const entries = branch?.entries;
  if (entries === undefined || typeof entries !== "object") return [];
  return Object.values(entries);
}

/**
 * 【D5】effective occupancy：live completion + reserved - matching pairs。
 * matching pair = reservation 的 transactionId 已有 live completion 在位
 * （写 completion 后 consume 前的中断窗口）——该 handoff 只计一槽。任一
 * 相关 store unhealthy → healthy=false（调用方 fail closed，不得用该计数
 * 放行 acquire）。
 */
export function peekTreasuryEffectiveCompletionOccupancy(): TreasuryEffectiveCompletionOccupancy {
  const completionHealth = peekTreasuryCleanupCompletionHealth();
  const reservationHealth = peekTreasuryCompletionHeadroomReservationHealth();
  if (!completionHealth.healthy || !reservationHealth.healthy) {
    return {
      live: -1,
      reserved: -1,
      pairs: -1,
      effective: Number.MAX_SAFE_INTEGER,
      healthy: false,
      detail: `completion=${completionHealth.healthy ? "ok" : completionHealth.detail} reservation=${reservationHealth.healthy ? "ok" : reservationHealth.detail}`,
    };
  }
  const live = peekTreasuryCleanupCompletionEntryCount();
  const reserved = peekTreasuryCompletionHeadroomReservationCount();
  let pairs = 0;
  for (const reservation of listTreasuryCompletionReservationEntries()) {
    if (lookupTreasuryCleanupCompletion(reservation.transactionId).verdict === "match") pairs += 1;
  }
  return { live, reserved, pairs, effective: live + reserved - pairs, healthy: true, detail: null };
}

export type TreasuryPrepareHeadroomAcquireResult =
  | { readonly status: "acquired" }
  | { readonly status: "already_reserved" }
  | {
      readonly status: "rejected";
      readonly reason: "capacity_exhausted" | "store_unhealthy";
      readonly detail: string;
    };

/**
 * 【D2/D5】prepare 的 completion headroom acquire（effective occupancy 口径
 * ——matching pair 不双计）。幂等；写入 + read-back 由 reservation 模块承载。
 */
export function acquireTreasuryCompletionHeadroomForPrepare(input: {
  readonly transactionId: string;
  readonly completionHardCapacity: number;
}): TreasuryPrepareHeadroomAcquireResult {
  const occupancy = peekTreasuryEffectiveCompletionOccupancy();
  if (!occupancy.healthy) {
    return { status: "rejected", reason: "store_unhealthy", detail: `effective occupancy 不可判定: ${occupancy.detail}` };
  }
  return acquireTreasuryCompletionHeadroomReservation({
    transactionId: input.transactionId,
    completionEntryCount: occupancy.effective,
    completionHardCapacity: input.completionHardCapacity,
  });
}

export type TreasuryPublicationAdmissionResult =
  | { readonly status: "admitted"; readonly recoveryAcquired: boolean }
  | { readonly status: "rejected"; readonly reason: "identity_mismatch" | "reservation_unavailable" | "store_unhealthy"; readonly detail: string };

/**
 * 【D4】completion publication 的 matching reservation admission：
 *  - matching reservation 在位：identity 绑定必须与 completion 的 durable
 *    identity digest 一致（未绑定时在此绑定；已绑定不同 → identity_mismatch
 *    ——R8：拒绝发布，reservation/journal/旧 proof 保留）；
 *  - 无 matching reservation（旧 cleanup / 正常 committed 后已释放 /
 *    中断恢复）：recovery acquire（effective occupancy 口径——R6：容量不足
 *    时不占用他人槽位 → reservation_unavailable，调用方保持 journal
 *    pending，不写 completion）。
 * 调用方：写入 completion 成功后必须 consumeTreasuryCompletionHandoff。
 */
export function admitTreasuryCompletionPublicationReservation(input: {
  readonly transactionId: string;
  readonly durableIdentityDigest: string;
  readonly completionHardCapacity: number;
}): TreasuryPublicationAdmissionResult {
  const existing = peekTreasuryCompletionHeadroomReservation(input.transactionId);
  if (existing !== undefined) {
    if (existing.boundIdentityDigest === undefined) {
      const bound = admitTreasuryCompletionHeadroomReservationForExecution({
        transactionId: input.transactionId,
        durableIdentityDigest: input.durableIdentityDigest,
      });
      if (bound.status === "rejected") {
        return { status: "rejected", reason: bound.reason === "identity_mismatch" ? "identity_mismatch" : "store_unhealthy", detail: bound.detail };
      }
      return { status: "admitted", recoveryAcquired: false };
    }
    if (existing.boundIdentityDigest !== input.durableIdentityDigest) {
      return {
        status: "rejected",
        reason: "identity_mismatch",
        detail: `reservation 已绑定不同 durable identity（${existing.boundIdentityDigest.slice(0, 8)} vs ${input.durableIdentityDigest.slice(0, 8)}——不得发布 completion；reservation/journal/旧 proof 保留）`,
      };
    }
    return { status: "admitted", recoveryAcquired: false };
  }
  let recovery = acquireTreasuryCompletionHeadroomForPrepare({
    transactionId: input.transactionId,
    completionHardCapacity: input.completionHardCapacity,
  });
  if (recovery.status === "rejected" && recovery.reason === "capacity_exhausted") {
    // 【D4 第 3 条】无 reservation 的 legacy cleanup 先安全回收 headroom
    //（bounded exact archive——completion 验证 → durable historical 写入
    // read-back → 删除 read-back）再重试一次 recovery acquire；仍失败才
    // 保持 journal pending（R6：不得占用他人 reservation 的槽）。
    const headroom = reclaimTreasuryCleanupCompletionHeadroom({ minSlots: 1 });
    if (headroom.reclaimed > 0) {
      recovery = acquireTreasuryCompletionHeadroomForPrepare({
        transactionId: input.transactionId,
        completionHardCapacity: input.completionHardCapacity,
      });
    }
  }
  if (recovery.status === "rejected") {
    return {
      status: "rejected",
      reason: recovery.reason === "capacity_exhausted" ? "reservation_unavailable" : "store_unhealthy",
      detail: `无 matching reservation，recovery acquire 失败（${recovery.reason}）: ${recovery.detail}——journal 保持 pending，不写 completion`,
    };
  }
  const bound = admitTreasuryCompletionHeadroomReservationForExecution({
    transactionId: input.transactionId,
    durableIdentityDigest: input.durableIdentityDigest,
  });
  if (bound.status === "rejected") {
    return { status: "rejected", reason: bound.reason === "identity_mismatch" ? "identity_mismatch" : "store_unhealthy", detail: bound.detail };
  }
  return { status: "admitted", recoveryAcquired: true };
}

/** 【D4】completion 写入成功后的受控 consume（checked——不静默）。 */
export function consumeTreasuryCompletionHandoff(transactionId: string): void {
  const result = consumeTreasuryCompletionHeadroomReservation(transactionId);
  if (result.status === "rejected") treasuryCompletionHandoffDiagnostics.consumeFailures += 1;
}

/** 【D3】显式释放（checked——不静默；失败时 reservation 保留由 TTL/恢复兜底）。 */
export function releaseTreasuryCompletionHeadroomChecked(transactionId: string): void {
  const result = consumeTreasuryCompletionHeadroomReservation(transactionId);
  if (result.status === "rejected") treasuryCompletionHandoffDiagnostics.releaseFailures += 1;
}

/**
 * 【D4/R9】beginTick recovery：matching pair（completion 在位 + reservation
 * 在位）→ 完成 consume（写 completion 后 consume 前中断的 handoff——恢复
 * 后只剩 completion，不留双计数）。identity 冲突的 pair 保留（不 consume
 * 不释放——结构化冲突留待处理）。返回 consume 数（诊断）。
 */
export function reconcileTreasuryReservationCompletionPairs(): number {
  const reservationHealth = peekTreasuryCompletionHeadroomReservationHealth();
  if (!reservationHealth.healthy) return 0;
  const completionHealth = peekTreasuryCleanupCompletionHealth();
  if (!completionHealth.healthy) return 0;
  let consumed = 0;
  for (const reservation of listTreasuryCompletionReservationEntries()) {
    const completion = lookupTreasuryCleanupCompletion(reservation.transactionId);
    if (completion.verdict !== "match") continue;
    const proofView = completion.proof as { durableIdentityDigest?: unknown; identity?: { durableIdentityDigest?: unknown } };
    const proofDigest = proofView.identity?.durableIdentityDigest ?? proofView.durableIdentityDigest;
    if (typeof proofDigest !== "string" || proofDigest.length === 0) continue; // identity 不可读：保留 pair（不 consume）
    if (reservation.boundIdentityDigest !== undefined && reservation.boundIdentityDigest !== proofDigest) {
      continue; // identity 冲突的 pair：保留（fail closed——不消费不释放）
    }
    const result = consumeTreasuryCompletionHeadroomReservation(reservation.transactionId);
    if (result.status === "released") {
      consumed += 1;
      treasuryCompletionHandoffDiagnostics.recoveryConsumed += 1;
    }
  }
  return consumed;
}

/**
 * 【D6】单一 reservation owner state：active handle 之外的 durable owner
 * 全集判定。返回 null = 无任何 owner（candidate orphan）；字符串 = owner
 * 描述（含 fail closed——任一 owner store unhealthy 视为 owned，不把
 * "读不到"解释成 orphan）。
 */
function reservationOwnerState(transactionId: string): string | null {
  if (readTreasuryIntentEntry(transactionId) !== undefined) return "durable intent";
  if (readTreasuryQuarantineEntry(transactionId) !== undefined) return "durable quarantine";
  const journalHealth = peekTreasuryResolutionCleanupHealth();
  if (!journalHealth.healthy) return `cleanup journal store unhealthy（fail closed）: ${journalHealth.detail ?? ""}`;
  if (readTreasuryResolutionCleanupEntry(transactionId) !== undefined) return "cleanup journal";
  if (tombstoneProbe === null) return "resolution owner probe 未装配（fail closed——视为 owned）";
  if (!tombstoneProbe.tombstoneStoreHealthy()) return "resolution store unhealthy（fail closed）";
  const tombstone = tombstoneProbe.tombstoneOf(transactionId);
  if (tombstone !== undefined && tombstone.stage !== "final") return `resolving resolution（stage=${String(tombstone.stage)}）`;
  const faultHealth = peekTreasuryAuthorizationFaultHealth();
  if (!faultHealth.healthy) return `authorization fault store unhealthy（fail closed）: ${faultHealth.detail ?? ""}`;
  if (readTreasuryAuthorizationFaultEntry(transactionId) !== undefined) return "authorization fault";
  const markerHealth = peekTreasuryWriteFaultHealth();
  if (!markerHealth.healthy) return `write-fault marker store unhealthy（fail closed）: ${markerHealth.detail ?? ""}`;
  const marker = readTreasuryWriteFault();
  if (marker !== undefined && marker.transactionId === transactionId) return "write-fault marker";
  if (lineageProbe !== null) {
    if (!lineageProbe.lineageStoreHealthy()) return "attempt lineage store unhealthy（fail closed）";
    const lineage = lineageProbe.lineageOf(transactionId);
    if (lineage !== undefined && lineage.state !== "chain_committed" && lineage.state !== "non_rearmable_retired" && lineage.state !== "forensic_isolated") {
      return `active lineage（state=${String(lineage.state)}）`;
    }
  }
  if (lookupTreasuryCleanupCompletion(transactionId).verdict === "match") return "matching live completion（pair——由 recovery consume）";
  return null;
}

/**
 * 【D6/R11/R12】TTL orphan sweep：只回收真正 orphan 的 reservation——
 * 无 durable owner（intent/quarantine/journal/resolution/fault/marker/
 * lineage/completion pair 全空）且超过 TTL 且非 active handle。owner store
 * unhealthy 时该 reservation 视为 owned（保守保留）。
 */
export function sweepOrphanTreasuryCompletionReservations(
  activeTransactionIds: ReadonlySet<string>,
): number {
  const reservationHealth = peekTreasuryCompletionHeadroomReservationHealth();
  if (!reservationHealth.healthy) return 0;
  let swept = 0;
  for (const reservation of listTreasuryCompletionReservationEntries()) {
    if (Game.time - reservation.reservedAtTick <= TREASURY_COMPLETION_RESERVATION_TTL_TICKS) continue;
    if (activeTransactionIds.has(reservation.transactionId)) continue;
    if (reservationOwnerState(reservation.transactionId) !== null) continue;
    const released = consumeTreasuryCompletionHeadroomReservation(reservation.transactionId);
    if (released.status === "released") {
      swept += 1;
      treasuryCompletionHandoffDiagnostics.orphanSwept += 1;
    }
  }
  return swept;
}
