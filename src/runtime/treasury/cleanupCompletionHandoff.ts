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
  releaseTreasuryCompletionHeadroomReservation,
  TREASURY_COMPLETION_RESERVATION_TTL_TICKS,
  type TreasuryCompletionHeadroomReservationEntry,
  type TreasuryReservationMutationResult,
} from "@/runtime/treasury/completionHeadroomReservation";
import { reclaimTreasuryCleanupCompletionHeadroom } from "@/runtime/treasury/cleanupCompletionReplacement";
import { resolveTreasuryAttemptLifecycleOwnership } from "@/runtime/treasury/treasuryLifecycleOwnerResolver";



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
 * 【D2/D5 → IX 工作流 E 8.1】completion headroom 的容量公式单一实现：
 * acquire 之后的 effective occupancy = live + independent reservation +
 * unresolved handoff slot − matching pair duplication。matching pair 恢复型
 * acquire（该 transactionId 已有 live completion 在位）不新增槽——同一
 * handoff 只计一次（O8：mixed live/reserved/pair 组合逐一满足单一公式；
 * O7：live=0 时第 128 个独立 reservation 成功、第 129 个才失败）。
 */
export function occupancyAfterTreasuryCompletionAcquire(
  occupancy: TreasuryEffectiveCompletionOccupancy,
  transactionId: string,
): number {
  const isMatchingPair = lookupTreasuryCleanupCompletion(transactionId).verdict === "match";
  return isMatchingPair ? occupancy.effective : occupancy.effective + 1;
}

/**
 * 【D2/D5】prepare 的 completion headroom acquire（effective occupancy 口径
 * ——matching pair 不双计）。幂等；写入 + read-back 由 reservation 模块承载
 * （底层只做边界比较——总量公式在本模块单一实现，不再二次叠加 reserved）。
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
    occupancyAfterAcquire: occupancyAfterTreasuryCompletionAcquire(occupancy, input.transactionId),
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

/**
 * 【D4 → IX 工作流 D 7.2】completion 写入成功后的受控 consume——结构化
 * 结果必须由调用方检查（H1/H2：store_unhealthy / read-back 失败时 journal
 * 不得删除、不得返回 completed；不再退化为 heap 计数器吞错）。
 */
export function consumeTreasuryCompletionHandoff(transactionId: string): TreasuryReservationMutationResult {
  const result = consumeTreasuryCompletionHeadroomReservation(transactionId);
  if (result.status === "rejected") treasuryCompletionHandoffDiagnostics.consumeFailures += 1;
  return result;
}

/**
 * 【D3 → IX 工作流 D 7.2】显式释放（callback 确定未开始的拒绝/abort/expired
 * 路径）——结构化结果由调用方检查（H3：失败时结果明确暴露"预留未释放"，
 * 不声称正常关闭；失败时 reservation 保留由 TTL/orphan sweep 兜底恢复）。
 * release 与 consume 语义分离（此前误调 consume 计数通道）。
 */
export function releaseTreasuryCompletionHeadroomChecked(transactionId: string): TreasuryReservationMutationResult {
  const result = releaseTreasuryCompletionHeadroomReservation(transactionId);
  if (result.status === "rejected") treasuryCompletionHandoffDiagnostics.releaseFailures += 1;
  return result;
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
 * 【D6 → IX 工作流 E 8.3】单一 reservation owner state：不再手工拼 store
 * 列表——统一经 treasuryLifecycleOwnerResolver（issued ticket / admission
 * reservation / headroom 互查 / intent / quarantine / journal / resolution /
 * fault / marker / lineage / matching completion 等完整权威）。返回 null =
 * 无 active owner（candidate orphan）；字符串 = owner 描述（含 fail
 * closed——任一相关 store unhealthy 视为 owned）。terminal-authority
 * （final tombstone / settled receipt / historical / GRA / summary）不阻止
 * reservation sweep（cleanup 已终结的 reservation 应释放）。
 */
function reservationOwnerState(transactionId: string): string | null {
  // sweep 的对象就是该 reservation 自身——排除 headroom 自引用维度。
  const ownership = resolveTreasuryAttemptLifecycleOwnership(transactionId, { excludeHeadroomReservation: true });
  if (ownership.status === "owned" && (ownership.kind === "active" || ownership.storeUnhealthy)) {
    return ownership.owner;
  }
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
